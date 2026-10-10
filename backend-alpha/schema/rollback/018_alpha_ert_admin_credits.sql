BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alpha_ert_admin_credits) OR
     EXISTS (SELECT 1 FROM alpha_accounts WHERE is_admin) OR
     EXISTS (SELECT 1 FROM alpha_ert_ledger WHERE event_key LIKE 'admin-credit:%') THEN
    RAISE EXCEPTION 'ERT admin credits or roles exist; rollback requires preserved evidence'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

DROP TABLE alpha_ert_admin_credits;
DROP FUNCTION alpha_ert_admin_credit_immutable();
ALTER TABLE alpha_accounts DROP COLUMN is_admin;

COMMIT;
