BEGIN;

CREATE TABLE alpha_cooper_level_eru_preparations (
  operation_id uuid PRIMARY KEY REFERENCES alpha_cooper_level_up_operations(id) ON DELETE RESTRICT,
  hybrid_operation_id uuid NOT NULL UNIQUE REFERENCES alpha_hybrid_operations(id) ON DELETE RESTRICT,
  reservation_id uuid NOT NULL UNIQUE REFERENCES alpha_ert_reservations(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  ring_id uuid NOT NULL,
  wallet_address text NOT NULL,
  cluster text NOT NULL CHECK (cluster IN ('local-validator', 'devnet')),
  expected_level integer NOT NULL CHECK (expected_level IN (4, 19)),
  target_level integer NOT NULL CHECK (target_level = expected_level + 1),
  unspent_points_before integer NOT NULL CHECK (unspent_points_before BETWEEN 0 AND 72),
  ert_cost numeric(48,18) NOT NULL CHECK (ert_cost > 0),
  eru_principal numeric(48,18) NOT NULL CHECK (eru_principal > 0),
  eru_fee numeric(48,18) NOT NULL CHECK (eru_fee > 0),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN
    ('prepared', 'unknown', 'confirmed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, ring_id)
    REFERENCES alpha_cooper_current_state(account_id, ring_id) ON DELETE RESTRICT,
  CHECK ((expected_level = 4 AND target_level = 5 AND ert_cost = 24 AND
    eru_principal = 30 AND eru_fee = 0.6) OR
    (expected_level = 19 AND target_level = 20 AND ert_cost = 84 AND
    eru_principal = 60 AND eru_fee = 1.2))
);
CREATE UNIQUE INDEX alpha_cooper_level_eru_active_ring
  ON alpha_cooper_level_eru_preparations(account_id, ring_id)
  WHERE status IN ('prepared', 'unknown');

CREATE FUNCTION alpha_cooper_level_eru_binding_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Status changes are intentionally unavailable until verified chain
  -- finalization/reconciliation is implemented in a later migration.
  RAISE EXCEPTION 'Cooper ERU preparation is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER alpha_cooper_level_eru_binding_immutable
  BEFORE UPDATE OR DELETE ON alpha_cooper_level_eru_preparations
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_level_eru_binding_immutable();

CREATE FUNCTION alpha_cooper_level_eru_validate_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM alpha_cooper_level_up_operations l
    JOIN alpha_hybrid_operations h ON h.id = NEW.hybrid_operation_id
    JOIN alpha_ert_reservations r ON r.id = NEW.reservation_id
    JOIN alpha_cooper_current_state c ON c.account_id = NEW.account_id
      AND c.ring_id = NEW.ring_id
    WHERE l.id = NEW.operation_id AND l.account_id = NEW.account_id
      AND l.ring_id = NEW.ring_id AND l.response_snapshot IS NULL
      AND c.level = NEW.expected_level
      AND c.unspent_attribute_points = NEW.unspent_points_before
      AND h.account_id = NEW.account_id AND h.wallet_address = NEW.wallet_address
      AND h.cluster = NEW.cluster AND h.operation_type = 'cooper_level_up'
      AND h.request_digest = NEW.request_digest AND h.ert_amount = NEW.ert_cost
      AND h.status = 'pending' AND r.operation_id = h.id
      AND r.account_id = NEW.account_id AND r.amount = NEW.ert_cost
      AND r.state = 'held'
  ) THEN
    RAISE EXCEPTION 'Cooper ERU preparation binding mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_cooper_level_eru_validate_binding
  BEFORE INSERT ON alpha_cooper_level_eru_preparations
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_level_eru_validate_binding();

CREATE FUNCTION alpha_cooper_level_eru_hold_blocks_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM alpha_cooper_level_eru_preparations
    WHERE account_id = OLD.account_id AND ring_id = OLD.ring_id
      AND status IN ('prepared', 'unknown')) THEN
    RAISE EXCEPTION 'Cooper progression has an unresolved ERU operation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_cooper_level_eru_hold_blocks_mutation
  BEFORE UPDATE ON alpha_cooper_current_state
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_level_eru_hold_blocks_mutation();

COMMIT;
