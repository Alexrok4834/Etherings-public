BEGIN;

CREATE TABLE alpha_admin_eru_transfers (
  id uuid PRIMARY KEY,
  actor_account_id uuid NOT NULL REFERENCES alpha_accounts(id),
  wallet_address text NOT NULL,
  amount_base_units bigint NOT NULL CHECK (amount_base_units BETWEEN 1 AND 50000000000),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 512),
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'UNKNOWN', 'CONFIRMED', 'FAILED')),
  confirmed_signature text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CHECK ((state IN ('PENDING', 'UNKNOWN') AND settled_at IS NULL
    AND confirmed_signature IS NULL) OR
    (state = 'CONFIRMED' AND settled_at IS NOT NULL
      AND confirmed_signature IS NOT NULL) OR
    (state = 'FAILED' AND settled_at IS NOT NULL
      AND confirmed_signature IS NULL))
);
CREATE INDEX alpha_admin_eru_transfer_queue
  ON alpha_admin_eru_transfers(created_at, id)
  WHERE state IN ('PENDING', 'UNKNOWN');

CREATE TABLE alpha_admin_eru_attempts (
  transfer_id uuid NOT NULL REFERENCES alpha_admin_eru_transfers(id),
  attempt integer NOT NULL CHECK (attempt > 0),
  signature text NOT NULL UNIQUE,
  raw_transaction_base64 text NOT NULL,
  blockhash text NOT NULL,
  last_valid_block_height bigint NOT NULL CHECK (last_valid_block_height > 0),
  state text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (state IN ('UNKNOWN', 'CONFIRMED', 'FAILED', 'EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY (transfer_id, attempt),
  CHECK ((state = 'UNKNOWN' AND settled_at IS NULL) OR
    (state <> 'UNKNOWN' AND settled_at IS NOT NULL))
);
CREATE UNIQUE INDEX alpha_admin_eru_one_unknown_attempt
  ON alpha_admin_eru_attempts(transfer_id) WHERE state = 'UNKNOWN';

CREATE FUNCTION alpha_admin_eru_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Admin ERU history is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'alpha_admin_eru_transfers' THEN
    IF (NEW.id, NEW.actor_account_id, NEW.wallet_address,
      NEW.amount_base_units, NEW.reason, NEW.created_at) IS DISTINCT FROM
      (OLD.id, OLD.actor_account_id, OLD.wallet_address,
      OLD.amount_base_units, OLD.reason, OLD.created_at) OR
      OLD.state IN ('CONFIRMED', 'FAILED') OR
      (OLD.state = 'PENDING' AND NEW.state NOT IN ('PENDING', 'UNKNOWN', 'CONFIRMED', 'FAILED')) OR
      (OLD.state = 'UNKNOWN' AND NEW.state NOT IN ('UNKNOWN', 'CONFIRMED', 'FAILED')) THEN
      RAISE EXCEPTION 'Admin ERU transfer binding or final state is immutable'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.transfer_id, NEW.attempt, NEW.signature, NEW.raw_transaction_base64,
      NEW.blockhash, NEW.last_valid_block_height, NEW.created_at) IS DISTINCT FROM
      (OLD.transfer_id, OLD.attempt, OLD.signature, OLD.raw_transaction_base64,
      OLD.blockhash, OLD.last_valid_block_height, OLD.created_at) OR
      OLD.state <> 'UNKNOWN' OR NEW.state NOT IN ('UNKNOWN', 'CONFIRMED', 'FAILED', 'EXPIRED') THEN
      RAISE EXCEPTION 'Admin ERU attempt is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_admin_eru_transfer_guard
  BEFORE UPDATE OR DELETE ON alpha_admin_eru_transfers
  FOR EACH ROW EXECUTE FUNCTION alpha_admin_eru_guard();
CREATE TRIGGER alpha_admin_eru_attempt_guard
  BEFORE UPDATE OR DELETE ON alpha_admin_eru_attempts
  FOR EACH ROW EXECUTE FUNCTION alpha_admin_eru_guard();

COMMIT;
