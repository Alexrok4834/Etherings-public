BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM alpha_cooper_current_state p
    JOIN alpha_starter_cooper s USING (account_id, ring_id)
    WHERE p.level <> s.level OR p.shine <> s.shine
      OR p.comfort <> s.comfort OR p.charm <> s.charm
      OR p.quality <> s.quality OR p.luck <> s.luck
      OR p.unspent_attribute_points <> 0
  ) THEN
    RAISE EXCEPTION 'Cooper progression exists; rollback would discard current gameplay state'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

DROP TRIGGER alpha_cooper_initialize_current_state ON alpha_starter_cooper;
DROP FUNCTION alpha_cooper_initialize_current_state();
DROP TRIGGER alpha_cooper_current_identity_immutable ON alpha_cooper_current_state;
DROP FUNCTION alpha_cooper_current_identity_immutable();
DROP TABLE alpha_cooper_current_state;
ALTER TABLE alpha_starter_cooper
  DROP CONSTRAINT alpha_starter_cooper_account_ring_unique;

COMMIT;
