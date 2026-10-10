BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alpha_cooper_level_up_operations) OR
     EXISTS (SELECT 1 FROM alpha_cooper_level_up_events) OR
     EXISTS (SELECT 1 FROM alpha_ert_ledger WHERE event_key LIKE 'cooper-level-up:%') THEN
    RAISE EXCEPTION 'Cooper Level-Up or ledger evidence exists; rollback would discard it'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

DROP TABLE alpha_cooper_level_up_events;
DROP TABLE alpha_cooper_level_up_operations;
DROP FUNCTION alpha_cooper_level_evidence_immutable();
DROP FUNCTION alpha_cooper_completed_level_immutable();

COMMIT;
