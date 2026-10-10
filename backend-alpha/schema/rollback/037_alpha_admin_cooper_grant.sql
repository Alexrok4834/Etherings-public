BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM alpha_admin_cooper_rings) THEN
    RAISE EXCEPTION 'Cannot remove issued admin Cooper history';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION alpha_cooper_current_owner_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM alpha_starter_cooper
      WHERE account_id = NEW.account_id AND ring_id = NEW.ring_id)
      AND NOT EXISTS (SELECT 1 FROM alpha_draw_cooper_rings
      WHERE account_id = NEW.account_id AND ring_id = NEW.ring_id) THEN
    RAISE EXCEPTION 'Cooper current state requires owned Ring provenance'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION alpha_ring_selection_cooper_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ring_kind = 'COOPER' AND NOT EXISTS (
    SELECT 1 FROM alpha_starter_cooper
    WHERE account_id = NEW.account_id AND ring_id::text = NEW.ring_id
  ) AND NOT EXISTS (
    SELECT 1 FROM alpha_draw_cooper_rings
    WHERE account_id = NEW.account_id AND ring_id::text = NEW.ring_id
  ) THEN
    RAISE EXCEPTION 'Cooper Ring is not owned by selection account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TABLE alpha_admin_cooper_rings;
DROP FUNCTION alpha_admin_cooper_immutable();

COMMIT;
