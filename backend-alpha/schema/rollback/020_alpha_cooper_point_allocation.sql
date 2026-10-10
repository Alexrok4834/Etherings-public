BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alpha_cooper_point_allocations) OR
     EXISTS (SELECT 1 FROM alpha_cooper_point_events) THEN
    RAISE EXCEPTION 'Cooper point evidence exists; rollback would discard it'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

DROP TABLE alpha_cooper_point_events;
DROP TABLE alpha_cooper_point_allocations;
DROP FUNCTION alpha_cooper_point_evidence_immutable();
DROP FUNCTION alpha_cooper_completed_allocation_immutable();

COMMIT;
