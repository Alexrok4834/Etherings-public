BEGIN;

-- Preserve the one-off report grant while allowing later audited admin grants.
ALTER TABLE alpha_admin_cooper_rings
  DROP CONSTRAINT alpha_admin_cooper_rings_issuance_reason_check;
ALTER TABLE alpha_admin_cooper_rings
  ADD CONSTRAINT alpha_admin_cooper_rings_issuance_reason_check
  CHECK (issuance_reason IN ('admin-report', 'admin-grant'));

COMMIT;
