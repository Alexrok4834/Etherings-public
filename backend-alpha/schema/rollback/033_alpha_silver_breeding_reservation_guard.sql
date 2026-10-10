BEGIN;

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
