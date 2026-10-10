BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alpha_cooper_level_eru_preparations) THEN
    RAISE EXCEPTION 'Cooper ERU preparation evidence exists; rollback would discard it'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

DROP TRIGGER alpha_cooper_level_eru_hold_blocks_mutation ON alpha_cooper_current_state;
DROP FUNCTION alpha_cooper_level_eru_hold_blocks_mutation();
DROP TABLE alpha_cooper_level_eru_preparations;
DROP FUNCTION alpha_cooper_level_eru_binding_immutable();
DROP FUNCTION alpha_cooper_level_eru_validate_binding();

COMMIT;
