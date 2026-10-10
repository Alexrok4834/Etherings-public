BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alpha_cooper_level_eru_submissions) OR
     EXISTS (SELECT 1 FROM alpha_cooper_level_eru_settlements) THEN
    RAISE EXCEPTION 'Cooper ERU settlement evidence exists; rollback would discard it'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

DROP TABLE alpha_cooper_level_eru_settlements;
DROP TABLE alpha_cooper_level_eru_submissions;
DROP FUNCTION alpha_cooper_eru_settlement_binding();
DROP FUNCTION alpha_cooper_eru_evidence_immutable();

CREATE OR REPLACE FUNCTION alpha_cooper_level_eru_binding_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cooper ERU preparation is immutable' USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE FUNCTION alpha_ert_reservation_hold_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ERT reservation requires verified settlement or release policy'
    USING ERRCODE = '23514';
END;
$$;

COMMIT;
