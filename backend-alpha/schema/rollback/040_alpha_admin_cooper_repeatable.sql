BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM alpha_admin_cooper_rings
    WHERE issuance_reason = 'admin-grant') THEN
    RAISE EXCEPTION 'Cannot remove issued admin Cooper history';
  END IF;
END $$;
ALTER TABLE alpha_admin_cooper_rings
  DROP CONSTRAINT alpha_admin_cooper_rings_issuance_reason_check;
ALTER TABLE alpha_admin_cooper_rings
  ADD CONSTRAINT alpha_admin_cooper_rings_issuance_reason_check
  CHECK (issuance_reason = 'admin-report');

COMMIT;
