BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM alpha_silver_direct_transfer_submissions LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back Silver direct transfer with durable submissions';
  END IF;
END $$;
DROP TABLE alpha_silver_direct_transfer_submissions;
COMMIT;
