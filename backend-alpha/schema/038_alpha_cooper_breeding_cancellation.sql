BEGIN;

-- Operator cancellation is terminal only for an expired, unsubmitted intent.
-- The finalized-chain readback is performed by the operator tool; the database
-- binds its evidence and releases all holds in the same transaction.
CREATE TABLE alpha_cooper_breeding_cancellations (
  operation_id uuid PRIMARY KEY REFERENCES alpha_cooper_breeding_operations(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  reservation_id uuid NOT NULL REFERENCES alpha_ert_reservations(id) ON DELETE RESTRICT,
  replay_address text NOT NULL CHECK (replay_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  finalized_slot bigint NOT NULL CHECK (finalized_slot > 0),
  evidence_digest char(64) NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 512),
  cancelled_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (operation_id, account_id)
    REFERENCES alpha_cooper_breeding_operations(id, account_id)
);

CREATE FUNCTION alpha_cooper_breeding_cancellation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM alpha_cooper_breeding_operations o
    JOIN alpha_cooper_breeding_issuances i ON i.operation_id = o.id
      AND i.account_id = o.account_id AND i.reservation_id = o.reservation_id
    JOIN alpha_ert_reservations r ON r.id = o.reservation_id
    JOIN alpha_hybrid_operations h ON h.id = o.hybrid_operation_id
    JOIN alpha_hybrid_outbox x ON x.operation_id = h.id
    WHERE o.id = NEW.operation_id AND o.account_id = NEW.account_id
      AND o.reservation_id = NEW.reservation_id
      AND NEW.finalized_slot > i.expiry_slot
      AND r.state = 'held' AND h.status = 'pending' AND x.state = 'pending'
      AND NOT EXISTS (SELECT 1 FROM alpha_cooper_breeding_submissions s
        WHERE s.operation_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM alpha_cooper_breeding_settlements s
        WHERE s.operation_id = o.id)) THEN
    RAISE EXCEPTION 'Cooper breeding cancellation binding mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_cooper_breeding_cancellation_guard
  BEFORE INSERT ON alpha_cooper_breeding_cancellations
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_breeding_cancellation_guard();
CREATE TRIGGER alpha_cooper_breeding_cancellation_immutable
  BEFORE UPDATE OR DELETE ON alpha_cooper_breeding_cancellations
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_breeding_evidence_immutable();

CREATE OR REPLACE FUNCTION alpha_cooper_breeding_hold_guard() RETURNS trigger
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
        NOT (EXISTS (SELECT 1 FROM alpha_cooper_breeding_settlements
          WHERE operation_id = OLD.operation_id) OR
          EXISTS (SELECT 1 FROM alpha_cooper_breeding_cancellations
          WHERE operation_id = OLD.operation_id AND account_id = OLD.account_id)) THEN
      RAISE EXCEPTION 'Cooper breeding parent hold release requires terminal evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION alpha_ert_reservation_hold_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.state = 'held' AND NEW.state = 'consumed' AND
     (to_jsonb(NEW) - 'state') = (to_jsonb(OLD) - 'state') AND
     (EXISTS (SELECT 1 FROM alpha_cooper_level_eru_settlements s
       WHERE s.reservation_id = OLD.id AND s.account_id = OLD.account_id) OR
      EXISTS (SELECT 1 FROM alpha_silver_progression_settlements s
       WHERE s.reservation_id = OLD.id AND s.account_id = OLD.account_id) OR
      EXISTS (SELECT 1 FROM alpha_cooper_breeding_settlements s
        JOIN alpha_cooper_breeding_operations o ON o.id = s.operation_id
        WHERE o.reservation_id = OLD.id AND s.account_id = OLD.account_id)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state = 'held' AND NEW.state = 'released' AND
     (to_jsonb(NEW) - 'state' - 'release_evidence_digest') =
     (to_jsonb(OLD) - 'state' - 'release_evidence_digest') AND
     OLD.release_evidence_digest IS NULL AND EXISTS (
       SELECT 1 FROM alpha_cooper_breeding_cancellations c
       WHERE c.reservation_id = OLD.id AND c.account_id = OLD.account_id
         AND c.evidence_digest = NEW.release_evidence_digest) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ERT reservation requires verified settlement or release policy'
    USING ERRCODE = '23514';
END;
$$;

COMMIT;
