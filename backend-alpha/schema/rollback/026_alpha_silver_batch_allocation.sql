BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alpha_silver_allocation_submissions
             WHERE allocation IS NOT NULL) THEN
    RAISE EXCEPTION 'Silver batch allocation evidence exists; rollback requires recovery decision';
  END IF;
END;
$$;

ALTER TABLE alpha_silver_allocation_submissions
  DROP CONSTRAINT alpha_silver_allocation_shape,
  DROP COLUMN allocation,
  ALTER COLUMN attribute SET NOT NULL;

COMMIT;
