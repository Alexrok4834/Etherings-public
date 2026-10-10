BEGIN;

CREATE TABLE alpha_admin_box_grants (
  id uuid PRIMARY KEY,
  actor_account_id uuid NOT NULL REFERENCES alpha_accounts(id),
  account_id uuid NOT NULL REFERENCES alpha_accounts(id),
  wallet_address text NOT NULL,
  issuance_id char(64) NOT NULL UNIQUE CHECK (issuance_id ~ '^[a-f0-9]{64}$'),
  entitlement_digest char(64) NOT NULL UNIQUE CHECK (entitlement_digest ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 512),
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','UNKNOWN','CONFIRMED','FAILED')),
  mint_address text UNIQUE,
  confirmed_signature text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CHECK ((state IN ('PENDING','UNKNOWN') AND settled_at IS NULL
    AND mint_address IS NULL AND confirmed_signature IS NULL) OR
    (state = 'CONFIRMED' AND settled_at IS NOT NULL
      AND mint_address IS NOT NULL AND confirmed_signature IS NOT NULL) OR
    (state = 'FAILED' AND settled_at IS NOT NULL
      AND mint_address IS NULL AND confirmed_signature IS NULL))
);
CREATE INDEX alpha_admin_box_queue ON alpha_admin_box_grants(created_at,id)
  WHERE state IN ('PENDING','UNKNOWN');

CREATE TABLE alpha_admin_box_attempts (
  grant_id uuid NOT NULL REFERENCES alpha_admin_box_grants(id),
  attempt integer NOT NULL CHECK (attempt > 0),
  signature text NOT NULL UNIQUE,
  raw_transaction_base64 text NOT NULL,
  blockhash text NOT NULL,
  last_valid_block_height bigint NOT NULL CHECK (last_valid_block_height > 0),
  mint_address text NOT NULL,
  state text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (state IN ('UNKNOWN','CONFIRMED','FAILED','EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY (grant_id,attempt),
  CHECK ((state = 'UNKNOWN' AND settled_at IS NULL) OR
    (state <> 'UNKNOWN' AND settled_at IS NOT NULL))
);
CREATE UNIQUE INDEX alpha_admin_box_one_unknown_attempt
  ON alpha_admin_box_attempts(grant_id) WHERE state = 'UNKNOWN';

CREATE FUNCTION alpha_admin_box_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Admin Box history is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'alpha_admin_box_grants' THEN
    IF (NEW.id,NEW.actor_account_id,NEW.account_id,NEW.wallet_address,
      NEW.issuance_id,NEW.entitlement_digest,NEW.reason,NEW.created_at)
      IS DISTINCT FROM
      (OLD.id,OLD.actor_account_id,OLD.account_id,OLD.wallet_address,
      OLD.issuance_id,OLD.entitlement_digest,OLD.reason,OLD.created_at) OR
      OLD.state IN ('CONFIRMED','FAILED') OR
      (OLD.state = 'UNKNOWN' AND NEW.state NOT IN ('UNKNOWN','CONFIRMED','FAILED')) THEN
      RAISE EXCEPTION 'Admin Box binding or final state is immutable'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.grant_id,NEW.attempt,NEW.signature,NEW.raw_transaction_base64,
      NEW.blockhash,NEW.last_valid_block_height,NEW.mint_address,NEW.created_at)
      IS DISTINCT FROM
      (OLD.grant_id,OLD.attempt,OLD.signature,OLD.raw_transaction_base64,
      OLD.blockhash,OLD.last_valid_block_height,OLD.mint_address,OLD.created_at) OR
      OLD.state <> 'UNKNOWN' THEN
      RAISE EXCEPTION 'Admin Box attempt is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_admin_box_grant_guard BEFORE UPDATE OR DELETE
  ON alpha_admin_box_grants FOR EACH ROW EXECUTE FUNCTION alpha_admin_box_guard();
CREATE TRIGGER alpha_admin_box_attempt_guard BEFORE UPDATE OR DELETE
  ON alpha_admin_box_attempts FOR EACH ROW EXECUTE FUNCTION alpha_admin_box_guard();

COMMIT;
