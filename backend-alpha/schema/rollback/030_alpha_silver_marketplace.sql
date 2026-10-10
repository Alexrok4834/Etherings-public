BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM alpha_silver_marketplace_submissions LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back Marketplace with durable submissions';
  END IF;
END $$;
DROP TABLE alpha_silver_marketplace_submissions;
COMMIT;
