BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alpha_m2e_comfort_changes) OR
     EXISTS (SELECT 1 FROM alpha_m2e_comfort_segments) THEN
    RAISE EXCEPTION 'M2E Comfort evidence exists; rollback requires reviewed recovery';
  END IF;
END;
$$;
DROP TABLE alpha_m2e_comfort_segments;
DROP TABLE alpha_m2e_comfort_changes;
DROP FUNCTION alpha_m2e_comfort_change_immutable();
DROP TABLE alpha_m2e_comfort_cutover;
COMMIT;
