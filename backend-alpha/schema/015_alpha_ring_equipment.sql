BEGIN;

CREATE TABLE alpha_ring_selection (
  account_id uuid PRIMARY KEY REFERENCES alpha_accounts(id) ON DELETE CASCADE,
  ring_kind text NOT NULL CHECK (ring_kind IN ('COOPER', 'SILVER_RING')),
  ring_id text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  equipped_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (ring_kind = 'COOPER' AND ring_id ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (ring_kind = 'SILVER_RING' AND ring_id ~
      '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  )
);

CREATE FUNCTION alpha_ring_selection_cooper_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ring_kind = 'COOPER' AND NOT EXISTS (
    SELECT 1 FROM alpha_starter_cooper
    WHERE account_id = NEW.account_id AND ring_id::text = NEW.ring_id
  ) THEN
    RAISE EXCEPTION 'Cooper Ring is not owned by selection account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER alpha_ring_selection_cooper_owned
  BEFORE INSERT OR UPDATE ON alpha_ring_selection
  FOR EACH ROW EXECUTE FUNCTION alpha_ring_selection_cooper_owned();

CREATE TABLE alpha_ring_equipment_operations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  response_snapshot jsonb NOT NULL CHECK (jsonb_typeof(response_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key)
);

CREATE TABLE alpha_ring_equipment_events (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  operation_key text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('INITIAL', 'EQUIP', 'FALLBACK')),
  previous_kind text CHECK (previous_kind IN ('COOPER', 'SILVER_RING')),
  previous_id text,
  current_kind text NOT NULL CHECK (current_kind IN ('COOPER', 'SILVER_RING')),
  current_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((previous_kind IS NULL) = (previous_id IS NULL)),
  UNIQUE (account_id, operation_key)
);

CREATE FUNCTION alpha_ring_equipment_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ring equipment event is immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER alpha_ring_equipment_event_immutable
  BEFORE UPDATE OR DELETE ON alpha_ring_equipment_events
  FOR EACH ROW EXECUTE FUNCTION alpha_ring_equipment_event_immutable();

CREATE TRIGGER alpha_ring_equipment_operation_immutable
  BEFORE UPDATE OR DELETE ON alpha_ring_equipment_operations
  FOR EACH ROW EXECUTE FUNCTION alpha_ring_equipment_event_immutable();

INSERT INTO alpha_ring_selection (account_id, ring_kind, ring_id, equipped_at, updated_at)
SELECT account_id, 'COOPER', ring_id::text, equipped_at, equipped_at
FROM alpha_starter_cooper;

INSERT INTO alpha_ring_equipment_events
  (id, account_id, operation_key, event_type, current_kind, current_id, reason, created_at)
SELECT audit_id, account_id, 'initial-starter', 'INITIAL', 'COOPER', ring_id::text,
  'STARTER_CLAIM', equipped_at
FROM alpha_starter_cooper;

COMMIT;
