BEGIN;

CREATE TABLE alpha_cooper_level_up_operations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  ring_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  rules_version text NOT NULL CHECK (rules_version = 'copper-level-up-v2'),
  response_snapshot jsonb CHECK (response_snapshot IS NULL OR
    jsonb_typeof(response_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (account_id, idempotency_key),
  CHECK ((response_snapshot IS NULL) = (completed_at IS NULL))
);

CREATE TABLE alpha_cooper_level_up_events (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  ring_id uuid NOT NULL,
  operation_id uuid NOT NULL UNIQUE REFERENCES alpha_cooper_level_up_operations(id),
  ledger_id uuid NOT NULL UNIQUE REFERENCES alpha_ert_ledger(id),
  event_type text NOT NULL CHECK (event_type = 'LEVEL_UP'),
  operation_key text NOT NULL,
  rules_version text NOT NULL CHECK (rules_version = 'copper-level-up-v2'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, operation_key),
  FOREIGN KEY (account_id, ring_id)
    REFERENCES alpha_cooper_current_state(account_id, ring_id) ON DELETE RESTRICT
);

CREATE FUNCTION alpha_cooper_level_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cooper Level-Up evidence is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER alpha_cooper_level_event_immutable
  BEFORE UPDATE OR DELETE ON alpha_cooper_level_up_events
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_level_evidence_immutable();

CREATE FUNCTION alpha_cooper_completed_level_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.response_snapshot IS NOT NULL THEN
    RAISE EXCEPTION 'completed Cooper Level-Up is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_cooper_completed_level_immutable
  BEFORE UPDATE OR DELETE ON alpha_cooper_level_up_operations
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_completed_level_immutable();

COMMIT;
