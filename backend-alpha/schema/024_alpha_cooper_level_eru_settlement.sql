BEGIN;

-- Record a submitted signature before broadcast/reconciliation so UNKNOWN can
-- be resumed after a process crash. A signature alone is never settlement.
CREATE TABLE alpha_cooper_level_eru_submissions (
  signature text PRIMARY KEY CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{80,90}$'),
  operation_id uuid NOT NULL REFERENCES alpha_cooper_level_eru_issuances(operation_id)
    ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, signature)
);
CREATE INDEX alpha_cooper_level_eru_submissions_operation_idx
  ON alpha_cooper_level_eru_submissions(operation_id);

CREATE TABLE alpha_cooper_level_eru_settlements (
  operation_id uuid PRIMARY KEY REFERENCES alpha_cooper_level_eru_issuances(operation_id)
    ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  hybrid_operation_id uuid NOT NULL UNIQUE REFERENCES alpha_hybrid_operations(id)
    ON DELETE RESTRICT,
  reservation_id uuid NOT NULL UNIQUE REFERENCES alpha_ert_reservations(id)
    ON DELETE RESTRICT,
  signature text NOT NULL UNIQUE REFERENCES alpha_cooper_level_eru_submissions(signature)
    ON DELETE RESTRICT,
  finalized_slot bigint NOT NULL CHECK (finalized_slot > 0),
  intent_digest char(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  transaction_digest char(64) NOT NULL CHECK (transaction_digest ~ '^[a-f0-9]{64}$'),
  operation_replay_digest char(64) NOT NULL CHECK
    (operation_replay_digest ~ '^[a-f0-9]{64}$'),
  ledger_id uuid NOT NULL UNIQUE REFERENCES alpha_ert_ledger(id) DEFERRABLE INITIALLY DEFERRED,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (operation_id, signature)
    REFERENCES alpha_cooper_level_eru_submissions(operation_id, signature)
);

CREATE FUNCTION alpha_cooper_eru_settlement_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM alpha_cooper_level_eru_preparations p
    JOIN alpha_cooper_level_eru_issuances i ON i.operation_id = p.operation_id
    JOIN alpha_cooper_level_eru_submissions sub
      ON sub.operation_id = p.operation_id AND sub.signature = NEW.signature
    JOIN alpha_hybrid_operations h ON h.id = p.hybrid_operation_id
    JOIN alpha_ert_reservations r ON r.id = p.reservation_id
    WHERE p.operation_id = NEW.operation_id AND p.account_id = NEW.account_id
      AND p.hybrid_operation_id = NEW.hybrid_operation_id
      AND p.reservation_id = NEW.reservation_id AND p.status = 'prepared'
      AND i.account_id = NEW.account_id AND i.intent_digest = NEW.intent_digest
      AND sub.account_id = NEW.account_id AND h.account_id = NEW.account_id
      AND h.status = 'pending' AND r.account_id = NEW.account_id
      AND r.state = 'held') THEN
    RAISE EXCEPTION 'Cooper ERU settlement binding mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_cooper_eru_settlement_binding
  BEFORE INSERT ON alpha_cooper_level_eru_settlements
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_eru_settlement_binding();

CREATE FUNCTION alpha_cooper_eru_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cooper ERU evidence is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER alpha_cooper_eru_submission_immutable
  BEFORE UPDATE OR DELETE ON alpha_cooper_level_eru_submissions
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_eru_evidence_immutable();
CREATE TRIGGER alpha_cooper_eru_settlement_immutable
  BEFORE UPDATE OR DELETE ON alpha_cooper_level_eru_settlements
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_eru_evidence_immutable();

CREATE OR REPLACE FUNCTION alpha_cooper_level_eru_binding_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IN ('prepared', 'unknown') AND
     NEW.status = 'confirmed' AND
     (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') AND
     EXISTS (SELECT 1 FROM alpha_cooper_level_eru_settlements s
       WHERE s.operation_id = OLD.operation_id AND s.account_id = OLD.account_id
         AND s.reservation_id = OLD.reservation_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Cooper ERU preparation is immutable' USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE FUNCTION alpha_ert_reservation_hold_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.state = 'held' AND NEW.state = 'consumed' AND
     (to_jsonb(NEW) - 'state') = (to_jsonb(OLD) - 'state') AND
     EXISTS (SELECT 1 FROM alpha_cooper_level_eru_settlements s
       WHERE s.reservation_id = OLD.id AND s.account_id = OLD.account_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ERT reservation requires verified settlement or release policy'
    USING ERRCODE = '23514';
END;
$$;

COMMIT;
