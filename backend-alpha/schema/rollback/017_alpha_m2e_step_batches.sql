BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alpha_m2e_batches) OR
     EXISTS (SELECT 1 FROM alpha_m2e_installations) THEN
    RAISE EXCEPTION 'M2E batch history exists; rollback requires preservation plan';
  END IF;
END;
$$;

DROP TABLE alpha_m2e_batches;
DROP TABLE alpha_m2e_installations;
DROP FUNCTION alpha_m2e_batch_immutable();

COMMIT;
