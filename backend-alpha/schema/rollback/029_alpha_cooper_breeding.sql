BEGIN;

-- Never discard a prepared, submitted or settled breeding operation. This
-- rollback is only for a migration that has not served a user operation.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alpha_cooper_breeding_operations) OR
     EXISTS (SELECT 1 FROM alpha_cooper_breeding_submissions) OR
     EXISTS (SELECT 1 FROM alpha_cooper_breeding_settlements) OR
     EXISTS (SELECT 1 FROM alpha_cooper_current_state WHERE breeding_uses <> 0) THEN
    RAISE EXCEPTION 'Cooper breeding rollback would discard active history'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

DROP TABLE alpha_cooper_breeding_settlements;
DROP TABLE alpha_cooper_breeding_submissions;
DROP TABLE alpha_cooper_breeding_issuances;
DROP TABLE alpha_cooper_breeding_parent_holds;
DROP TABLE alpha_cooper_breeding_operations;
DROP TRIGGER alpha_cooper_breeding_counter_guard ON alpha_cooper_current_state;
DROP FUNCTION alpha_cooper_breeding_operation_guard();
DROP FUNCTION alpha_cooper_breeding_issuance_guard();
DROP FUNCTION alpha_cooper_breeding_two_holds();
DROP FUNCTION alpha_cooper_breeding_hold_guard();
DROP FUNCTION alpha_cooper_breeding_counter_guard();
DROP FUNCTION alpha_cooper_breeding_evidence_immutable();
ALTER TABLE alpha_cooper_current_state DROP COLUMN breeding_uses;

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
