BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM alpha_admin_box_grants) THEN
    RAISE EXCEPTION 'Cannot remove admin Box grant history';
  END IF;
END $$;
DROP TABLE alpha_admin_box_attempts;
DROP TABLE alpha_admin_box_grants;
DROP FUNCTION alpha_admin_box_guard();
COMMIT;
