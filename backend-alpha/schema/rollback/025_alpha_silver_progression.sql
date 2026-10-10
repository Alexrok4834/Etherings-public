BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alpha_silver_progression_operations LIMIT 1) OR
     EXISTS (SELECT 1 FROM alpha_silver_progression_submissions LIMIT 1) OR
     EXISTS (SELECT 1 FROM alpha_silver_progression_settlements LIMIT 1) OR
     EXISTS (SELECT 1 FROM alpha_silver_allocation_submissions LIMIT 1) THEN
    RAISE EXCEPTION 'Silver progression evidence exists; rollback requires separate recovery decision';
  END IF;
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

DROP TABLE alpha_silver_progression_settlements;
DROP TABLE alpha_silver_progression_submissions;
DROP TABLE alpha_silver_allocation_submissions;
DROP TABLE alpha_silver_progression_operations;
DROP FUNCTION alpha_silver_progression_settlement_binding();
DROP FUNCTION alpha_silver_progression_binding();
DROP FUNCTION alpha_silver_progression_operation_guard();
DROP FUNCTION alpha_silver_progression_evidence_immutable();

COMMIT;
