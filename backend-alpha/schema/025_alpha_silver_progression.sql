BEGIN;

-- Silver remains chain-authoritative. These rows bind the off-chain ERT hold
-- and durable recovery evidence to one user-approved on-chain transition.
CREATE TABLE alpha_silver_progression_operations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  mint_address text NOT NULL CHECK (mint_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  issuance_id char(64) NOT NULL CHECK (issuance_id ~ '^[a-f0-9]{64}$'),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  cluster text NOT NULL CHECK (cluster = 'devnet'),
  expected_level integer NOT NULL CHECK (expected_level BETWEEN 1 AND 19),
  target_level integer NOT NULL CHECK (target_level = expected_level + 1),
  ert_cost numeric(48,18) NOT NULL CHECK (ert_cost = 5 * (target_level + 1)),
  hybrid_operation_id uuid NOT NULL UNIQUE REFERENCES alpha_hybrid_operations(id)
    ON DELETE RESTRICT,
  reservation_id uuid NOT NULL UNIQUE REFERENCES alpha_ert_reservations(id)
    ON DELETE RESTRICT,
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','confirmed')),
  response_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (account_id, idempotency_key),
  CHECK (target_level NOT IN (5, 20)),
  CHECK ((status = 'prepared' AND response_snapshot IS NULL AND completed_at IS NULL) OR
    (status = 'confirmed' AND response_snapshot IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX alpha_silver_progression_one_pending_ring
  ON alpha_silver_progression_operations(mint_address) WHERE status = 'prepared';

CREATE TABLE alpha_silver_progression_submissions (
  signature text PRIMARY KEY CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{80,90}$'),
  operation_id uuid NOT NULL REFERENCES alpha_silver_progression_operations(id)
    ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  message_base64 text NOT NULL,
  issuer_signature_base64 text NOT NULL,
  intent_digest char(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, signature)
);
CREATE INDEX alpha_silver_progression_submissions_operation
  ON alpha_silver_progression_submissions(operation_id);

CREATE TABLE alpha_silver_allocation_submissions (
  signature text PRIMARY KEY CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{80,90}$'),
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  mint_address text NOT NULL CHECK (mint_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  wallet_address text NOT NULL,
  message_base64 text NOT NULL,
  intent_digest char(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  attribute text NOT NULL CHECK (attribute IN ('comfort','charm','quality','luck')),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alpha_silver_allocation_account
  ON alpha_silver_allocation_submissions(account_id, mint_address, recorded_at);

CREATE TABLE alpha_silver_progression_settlements (
  operation_id uuid PRIMARY KEY REFERENCES alpha_silver_progression_operations(id)
    ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  hybrid_operation_id uuid NOT NULL UNIQUE REFERENCES alpha_hybrid_operations(id)
    ON DELETE RESTRICT,
  reservation_id uuid NOT NULL UNIQUE REFERENCES alpha_ert_reservations(id)
    ON DELETE RESTRICT,
  signature text NOT NULL UNIQUE REFERENCES alpha_silver_progression_submissions(signature)
    ON DELETE RESTRICT,
  finalized_slot bigint NOT NULL CHECK (finalized_slot > 0),
  intent_digest char(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  transaction_digest char(64) NOT NULL CHECK (transaction_digest ~ '^[a-f0-9]{64}$'),
  replay_digest char(64) NOT NULL CHECK (replay_digest ~ '^[a-f0-9]{64}$'),
  ledger_id uuid NOT NULL UNIQUE REFERENCES alpha_ert_ledger(id)
    DEFERRABLE INITIALLY DEFERRED,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (operation_id, signature)
    REFERENCES alpha_silver_progression_submissions(operation_id, signature)
);

CREATE FUNCTION alpha_silver_progression_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Silver progression evidence is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER alpha_silver_progression_submission_immutable
  BEFORE UPDATE OR DELETE ON alpha_silver_progression_submissions
  FOR EACH ROW EXECUTE FUNCTION alpha_silver_progression_evidence_immutable();
CREATE TRIGGER alpha_silver_allocation_submission_immutable
  BEFORE UPDATE OR DELETE ON alpha_silver_allocation_submissions
  FOR EACH ROW EXECUTE FUNCTION alpha_silver_progression_evidence_immutable();
CREATE TRIGGER alpha_silver_progression_settlement_immutable
  BEFORE UPDATE OR DELETE ON alpha_silver_progression_settlements
  FOR EACH ROW EXECUTE FUNCTION alpha_silver_progression_evidence_immutable();

CREATE FUNCTION alpha_silver_progression_operation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'prepared' AND NEW.status = 'confirmed' AND
     (to_jsonb(NEW) - 'status' - 'response_snapshot' - 'completed_at') =
     (to_jsonb(OLD) - 'status' - 'response_snapshot' - 'completed_at') AND
     NEW.response_snapshot IS NOT NULL AND NEW.completed_at IS NOT NULL AND
     EXISTS (SELECT 1 FROM alpha_silver_progression_settlements s
       WHERE s.operation_id = OLD.id AND s.account_id = OLD.account_id
         AND s.reservation_id = OLD.reservation_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Silver progression operation is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER alpha_silver_progression_operation_guard
  BEFORE UPDATE OR DELETE ON alpha_silver_progression_operations
  FOR EACH ROW EXECUTE FUNCTION alpha_silver_progression_operation_guard();

CREATE FUNCTION alpha_silver_progression_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM alpha_hybrid_operations h
    JOIN alpha_ert_reservations r ON r.operation_id = h.id
    JOIN alpha_hybrid_outbox o ON o.operation_id = h.id
    JOIN alpha_wallet_bindings w ON w.account_id = NEW.account_id
    JOIN alpha_silver_opening_finalizations f ON f.ring_mint_address = NEW.mint_address
    JOIN alpha_silver_first_entry e ON e.account_id = f.account_id
      AND e.cluster = f.cluster
    WHERE h.id = NEW.hybrid_operation_id AND h.account_id = NEW.account_id
      AND h.wallet_address = NEW.wallet_address AND h.cluster = NEW.cluster
      AND h.operation_type = 'silver_progression' AND h.status = 'pending'
      AND h.request_digest = NEW.request_digest AND h.ert_amount = NEW.ert_cost
      AND r.id = NEW.reservation_id AND r.account_id = NEW.account_id
      AND r.amount = NEW.ert_cost AND r.state = 'held'
      AND o.payload_digest = NEW.request_digest
      AND w.wallet_address = NEW.wallet_address
      AND f.status = 'confirmed' AND e.issuance_id = NEW.issuance_id
      AND e.status = 'confirmed') THEN
    RAISE EXCEPTION 'Silver progression binding mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_silver_progression_binding
  BEFORE INSERT ON alpha_silver_progression_operations
  FOR EACH ROW EXECUTE FUNCTION alpha_silver_progression_binding();

CREATE FUNCTION alpha_silver_progression_settlement_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM alpha_silver_progression_operations o
    JOIN alpha_silver_progression_submissions sub ON sub.operation_id = o.id
      AND sub.signature = NEW.signature
    JOIN alpha_hybrid_operations h ON h.id = o.hybrid_operation_id
    JOIN alpha_ert_reservations r ON r.id = o.reservation_id
    WHERE o.id = NEW.operation_id AND o.account_id = NEW.account_id
      AND o.hybrid_operation_id = NEW.hybrid_operation_id
      AND o.reservation_id = NEW.reservation_id AND o.status = 'prepared'
      AND sub.account_id = NEW.account_id AND sub.intent_digest = NEW.intent_digest
      AND h.account_id = NEW.account_id AND h.status = 'pending'
      AND r.account_id = NEW.account_id AND r.state = 'held') THEN
    RAISE EXCEPTION 'Silver progression settlement binding mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_silver_progression_settlement_binding
  BEFORE INSERT ON alpha_silver_progression_settlements
  FOR EACH ROW EXECUTE FUNCTION alpha_silver_progression_settlement_binding();

-- 024 intentionally admits only verified Cooper settlements. Add Silver
-- without relaxing the prior guard or allowing an unverified release.
CREATE OR REPLACE FUNCTION alpha_ert_reservation_hold_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.state = 'held' AND NEW.state = 'consumed' AND
     (to_jsonb(NEW) - 'state') = (to_jsonb(OLD) - 'state') AND
     (EXISTS (SELECT 1 FROM alpha_cooper_level_eru_settlements s
       WHERE s.reservation_id = OLD.id AND s.account_id = OLD.account_id) OR
      EXISTS (SELECT 1 FROM alpha_silver_progression_settlements s
       WHERE s.reservation_id = OLD.id AND s.account_id = OLD.account_id)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ERT reservation requires verified settlement or release policy'
    USING ERRCODE = '23514';
END;
$$;

COMMIT;
