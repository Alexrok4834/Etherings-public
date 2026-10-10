BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alpha_refresh_tokens) OR
     EXISTS (SELECT 1 FROM alpha_sessions WHERE family_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot remove active Alpha renewal evidence';
  END IF;
END;
$$;

DROP TABLE alpha_refresh_tokens;
ALTER TABLE alpha_sessions DROP COLUMN family_id;

COMMIT;
