BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alpha_cooper_level_eru_issuances) THEN
    RAISE EXCEPTION 'Cooper ERU issuance evidence exists; rollback would discard it'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

DROP TABLE alpha_cooper_level_eru_issuances;
DROP FUNCTION alpha_cooper_level_eru_issuance_guard();

COMMIT;
