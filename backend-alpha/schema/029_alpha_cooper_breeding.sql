BEGIN;

-- The existing owned Cooper current-state row remains the single gameplay
-- authority. A successful, finalized breeding may consume one of two uses.
ALTER TABLE alpha_cooper_current_state
  ADD COLUMN breeding_uses integer NOT NULL DEFAULT 0
    CHECK (breeding_uses BETWEEN 0 AND 2);

CREATE TABLE alpha_cooper_breeding_operations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  hybrid_operation_id uuid NOT NULL UNIQUE REFERENCES alpha_hybrid_operations(id),
  reservation_id uuid NOT NULL UNIQUE REFERENCES alpha_ert_reservations(id),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  cluster text NOT NULL CHECK (cluster IN ('local-validator', 'devnet')),
  idempotency_key uuid NOT NULL,
  request_fingerprint char(64) NOT NULL CHECK
    (request_fingerprint ~ '^[a-f0-9]{64}$'),
  first_ring_id uuid NOT NULL,
  second_ring_id uuid NOT NULL,
  first_uses integer NOT NULL CHECK (first_uses BETWEEN 0 AND 1),
  second_uses integer NOT NULL CHECK (second_uses BETWEEN 0 AND 1),
  ert_cost numeric(48,18) NOT NULL,
  eru_principal numeric(48,18) NOT NULL,
  eru_fee numeric(48,18) NOT NULL,
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  issuance_id char(64) NOT NULL UNIQUE CHECK (issuance_id ~ '^[a-f0-9]{64}$'),
  entitlement_digest char(64) NOT NULL UNIQUE CHECK
    (entitlement_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key),
  UNIQUE (id, account_id),
  CHECK (first_ring_id <> second_ring_id),
  CHECK ((first_uses = 0 AND second_uses = 0 AND ert_cost = 150
           AND eru_principal = 30 AND eru_fee = 0.6) OR
         (first_uses = 0 AND second_uses = 1 AND ert_cost = 200
           AND eru_principal = 40 AND eru_fee = 0.8) OR
         (first_uses = 1 AND second_uses = 0 AND ert_cost = 200
           AND eru_principal = 40 AND eru_fee = 0.8) OR
         (first_uses = 1 AND second_uses = 1 AND ert_cost = 250
           AND eru_principal = 50 AND eru_fee = 1)),
  FOREIGN KEY (account_id, first_ring_id)
    REFERENCES alpha_cooper_current_state(account_id, ring_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, second_ring_id)
    REFERENCES alpha_cooper_current_state(account_id, ring_id) ON DELETE RESTRICT
);

CREATE FUNCTION alpha_cooper_breeding_operation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM alpha_hybrid_operations h
    JOIN alpha_ert_reservations r ON r.operation_id = h.id
    JOIN alpha_hybrid_outbox x ON x.operation_id = h.id
    WHERE h.id = NEW.hybrid_operation_id AND r.id = NEW.reservation_id
      AND h.account_id = NEW.account_id AND r.account_id = NEW.account_id
      AND h.wallet_address = NEW.wallet_address AND h.cluster = NEW.cluster
      AND h.operation_type = 'cooper_breeding'
      AND h.request_digest = NEW.request_digest
      AND x.payload_digest = NEW.request_digest
      AND h.ert_amount = NEW.ert_cost AND r.amount = NEW.ert_cost
      AND h.status = 'pending' AND r.state = 'held') OR
      NOT EXISTS (SELECT 1 FROM alpha_cooper_current_state c
        WHERE c.account_id = NEW.account_id AND c.ring_id = NEW.first_ring_id
          AND c.level = 20 AND c.breeding_uses = NEW.first_uses) OR
      NOT EXISTS (SELECT 1 FROM alpha_cooper_current_state c
        WHERE c.account_id = NEW.account_id AND c.ring_id = NEW.second_ring_id
          AND c.level = 20 AND c.breeding_uses = NEW.second_uses) THEN
    RAISE EXCEPTION 'Cooper breeding preparation binding mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_cooper_breeding_operation_guard
  BEFORE INSERT ON alpha_cooper_breeding_operations
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_breeding_operation_guard();

-- A parent is reserved before any RPC/signing. Its hold cannot expire by TTL;
-- only a verified terminal chain result may release it.
CREATE TABLE alpha_cooper_breeding_parent_holds (
  operation_id uuid NOT NULL REFERENCES alpha_cooper_breeding_operations(id)
    ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  ring_id uuid NOT NULL,
  uses_before integer NOT NULL CHECK (uses_before BETWEEN 0 AND 1),
  released_at timestamptz,
  PRIMARY KEY (operation_id, ring_id),
  FOREIGN KEY (account_id, ring_id)
    REFERENCES alpha_cooper_current_state(account_id, ring_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX alpha_cooper_breeding_one_active_hold_per_parent
  ON alpha_cooper_breeding_parent_holds(account_id, ring_id)
  WHERE released_at IS NULL;

CREATE FUNCTION alpha_cooper_breeding_two_holds() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM alpha_cooper_breeding_parent_holds
      WHERE operation_id = NEW.id) <> 2 THEN
    RAISE EXCEPTION 'Cooper breeding requires exactly two reserved parents'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER alpha_cooper_breeding_two_holds
  AFTER INSERT ON alpha_cooper_breeding_operations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_breeding_two_holds();

CREATE TABLE alpha_cooper_breeding_issuances (
  operation_id uuid PRIMARY KEY REFERENCES alpha_cooper_breeding_operations(id)
    ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  reservation_id uuid NOT NULL REFERENCES alpha_ert_reservations(id),
  wallet_address text NOT NULL,
  cluster text NOT NULL CHECK (cluster = 'devnet'),
  genesis_hash text NOT NULL,
  gateway_program_id text NOT NULL,
  attestor_address text NOT NULL,
  intent_digest char(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  nonce bigint NOT NULL CHECK (nonce > 0),
  config_epoch bigint NOT NULL CHECK (config_epoch > 0),
  expiry_slot bigint NOT NULL CHECK (expiry_slot > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, account_id),
  FOREIGN KEY (operation_id, account_id)
    REFERENCES alpha_cooper_breeding_operations(id, account_id)
);

CREATE FUNCTION alpha_cooper_breeding_issuance_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM alpha_cooper_breeding_operations o
    JOIN alpha_ert_reservations r ON r.id = o.reservation_id
    WHERE o.id = NEW.operation_id AND o.account_id = NEW.account_id
      AND o.reservation_id = NEW.reservation_id
      AND o.wallet_address = NEW.wallet_address AND o.cluster = NEW.cluster
      AND r.state = 'held') THEN
    RAISE EXCEPTION 'Cooper breeding issuance binding mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_cooper_breeding_issuance_guard
  BEFORE INSERT ON alpha_cooper_breeding_issuances
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_breeding_issuance_guard();

CREATE TABLE alpha_cooper_breeding_submissions (
  signature text PRIMARY KEY CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{80,90}$'),
  operation_id uuid NOT NULL REFERENCES alpha_cooper_breeding_operations(id)
    ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, signature),
  FOREIGN KEY (operation_id, account_id)
    REFERENCES alpha_cooper_breeding_issuances(operation_id, account_id)
);

CREATE TABLE alpha_cooper_breeding_settlements (
  operation_id uuid PRIMARY KEY REFERENCES alpha_cooper_breeding_operations(id)
    ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  signature text NOT NULL UNIQUE,
  finalized_slot bigint NOT NULL CHECK (finalized_slot > 0),
  transaction_digest char(64) NOT NULL CHECK
    (transaction_digest ~ '^[a-f0-9]{64}$'),
  operation_replay_digest char(64) NOT NULL CHECK
    (operation_replay_digest ~ '^[a-f0-9]{64}$'),
  box_mint text NOT NULL UNIQUE CHECK
    (box_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  ledger_id uuid NOT NULL UNIQUE REFERENCES alpha_ert_ledger(id)
    DEFERRABLE INITIALLY DEFERRED,
  settled_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (operation_id, signature)
    REFERENCES alpha_cooper_breeding_submissions(operation_id, signature)
);

CREATE FUNCTION alpha_cooper_breeding_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cooper breeding evidence is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER alpha_cooper_breeding_operation_immutable
  BEFORE UPDATE OR DELETE ON alpha_cooper_breeding_operations
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_breeding_evidence_immutable();
CREATE TRIGGER alpha_cooper_breeding_submission_immutable
  BEFORE UPDATE OR DELETE ON alpha_cooper_breeding_submissions
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_breeding_evidence_immutable();
CREATE TRIGGER alpha_cooper_breeding_issuance_immutable
  BEFORE UPDATE OR DELETE ON alpha_cooper_breeding_issuances
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_breeding_evidence_immutable();
CREATE TRIGGER alpha_cooper_breeding_settlement_immutable
  BEFORE UPDATE OR DELETE ON alpha_cooper_breeding_settlements
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_breeding_evidence_immutable();

CREATE FUNCTION alpha_cooper_breeding_counter_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.breeding_uses <> OLD.breeding_uses AND NOT EXISTS (
    SELECT 1 FROM alpha_cooper_breeding_settlements s
    JOIN alpha_cooper_breeding_parent_holds h
      ON h.operation_id = s.operation_id
    WHERE h.account_id = OLD.account_id AND h.ring_id = OLD.ring_id
      AND h.uses_before = OLD.breeding_uses
      AND NEW.breeding_uses = OLD.breeding_uses + 1
      AND h.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Cooper breeding use needs finalized settlement'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_cooper_breeding_counter_guard
  BEFORE UPDATE OF breeding_uses ON alpha_cooper_current_state
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_breeding_counter_guard();

CREATE FUNCTION alpha_cooper_breeding_hold_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE op alpha_cooper_breeding_operations%ROWTYPE;
BEGIN
  SELECT * INTO op FROM alpha_cooper_breeding_operations WHERE id = NEW.operation_id;
  IF TG_OP = 'INSERT' THEN
    IF op.id IS NULL OR NEW.released_at IS NOT NULL OR
        NEW.account_id <> op.account_id OR NOT (
          (NEW.ring_id = op.first_ring_id AND NEW.uses_before = op.first_uses) OR
          (NEW.ring_id = op.second_ring_id AND NEW.uses_before = op.second_uses)) THEN
      RAISE EXCEPTION 'Cooper breeding parent hold mismatch' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL OR
        (to_jsonb(NEW) - 'released_at') <> (to_jsonb(OLD) - 'released_at') OR
        NOT EXISTS (SELECT 1 FROM alpha_cooper_breeding_settlements
          WHERE operation_id = OLD.operation_id) THEN
      RAISE EXCEPTION 'Cooper breeding parent hold release requires settlement'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_cooper_breeding_hold_guard
  BEFORE INSERT OR UPDATE ON alpha_cooper_breeding_parent_holds
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_breeding_hold_guard();
CREATE TRIGGER alpha_cooper_breeding_hold_no_delete
  BEFORE DELETE ON alpha_cooper_breeding_parent_holds
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_breeding_evidence_immutable();

CREATE OR REPLACE FUNCTION alpha_ert_reservation_hold_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.state = 'held' AND NEW.state = 'consumed' AND
     (to_jsonb(NEW) - 'state') = (to_jsonb(OLD) - 'state') AND
     (EXISTS (SELECT 1 FROM alpha_cooper_level_eru_settlements s
       WHERE s.reservation_id = OLD.id AND s.account_id = OLD.account_id) OR
      EXISTS (SELECT 1 FROM alpha_cooper_breeding_settlements s
        JOIN alpha_cooper_breeding_operations o ON o.id = s.operation_id
        WHERE o.reservation_id = OLD.id AND s.account_id = OLD.account_id)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ERT reservation requires verified settlement or release policy'
    USING ERRCODE = '23514';
END;
$$;

COMMIT;
