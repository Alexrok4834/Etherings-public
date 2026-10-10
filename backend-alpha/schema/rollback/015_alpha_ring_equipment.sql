BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alpha_ring_equipment_operations) OR
     EXISTS (SELECT 1 FROM alpha_ring_equipment_events WHERE event_type <> 'INITIAL') THEN
    RAISE EXCEPTION 'ring equipment history exists; rollback requires preservation plan';
  END IF;
END;
$$;

DROP TABLE alpha_ring_equipment_events;
DROP TABLE alpha_ring_equipment_operations;
DROP TABLE alpha_ring_selection;
DROP FUNCTION alpha_ring_equipment_event_immutable();
DROP FUNCTION alpha_ring_selection_cooper_owned();

COMMIT;
