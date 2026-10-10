BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alpha_m2e_settlements) OR
     EXISTS (SELECT 1 FROM alpha_m2e_daily_stats) OR
     EXISTS (SELECT 1 FROM alpha_m2e_daily_snapshots) OR
     EXISTS (SELECT 1 FROM alpha_ert_ledger WHERE event_key LIKE 'm2e-step-batch:%') THEN
    RAISE EXCEPTION 'M2E accounting history exists; rollback requires preservation plan';
  END IF;
END;
$$;

DROP TABLE alpha_m2e_settlements;
DROP TABLE alpha_m2e_daily_stats;
DROP TABLE alpha_m2e_daily_snapshots;
DROP FUNCTION alpha_m2e_snapshot_immutable();

COMMIT;
