BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM alpha_admin_eru_transfers LIMIT 1) THEN
    RAISE EXCEPTION 'Admin ERU transfers exist; rollback prohibited';
  END IF;
END $$;
DROP TABLE alpha_admin_eru_attempts;
DROP TABLE alpha_admin_eru_transfers;
DROP FUNCTION alpha_admin_eru_guard();

COMMIT;
