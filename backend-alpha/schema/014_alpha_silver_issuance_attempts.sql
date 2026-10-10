BEGIN;

CREATE TABLE alpha_silver_issuance_attempts (
  account_id uuid NOT NULL,
  cluster text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  wallet_address text NOT NULL,
  issuance_id text NOT NULL CHECK (issuance_id ~ '^[a-f0-9]{64}$'),
  entitlement_digest text NOT NULL CHECK (entitlement_digest ~ '^[a-f0-9]{64}$'),
  mint_address text NOT NULL,
  token_address text NOT NULL,
  issuer_address text NOT NULL,
  raw_transaction_base64 text NOT NULL,
  blockhash text NOT NULL,
  last_valid_block_height bigint NOT NULL CHECK (last_valid_block_height > 0),
  signature text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'confirmed', 'expired', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY (account_id, cluster, attempt),
  FOREIGN KEY (account_id, cluster)
    REFERENCES alpha_silver_first_entry (account_id, cluster),
  CONSTRAINT alpha_silver_issuance_attempt_settled CHECK
    ((status = 'unknown' AND settled_at IS NULL) OR
     (status <> 'unknown' AND settled_at IS NOT NULL))
);

CREATE INDEX alpha_silver_issuance_attempts_latest
  ON alpha_silver_issuance_attempts (account_id, cluster, attempt DESC);

CREATE FUNCTION alpha_silver_issuance_attempt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.account_id, OLD.cluster, OLD.attempt, OLD.wallet_address,
         OLD.issuance_id, OLD.entitlement_digest, OLD.mint_address,
         OLD.token_address, OLD.issuer_address, OLD.raw_transaction_base64,
         OLD.blockhash, OLD.last_valid_block_height, OLD.signature, OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.account_id, NEW.cluster, NEW.attempt, NEW.wallet_address,
         NEW.issuance_id, NEW.entitlement_digest, NEW.mint_address,
         NEW.token_address, NEW.issuer_address, NEW.raw_transaction_base64,
         NEW.blockhash, NEW.last_valid_block_height, NEW.signature, NEW.created_at)
     OR OLD.status <> 'unknown' OR NEW.status NOT IN ('confirmed', 'expired', 'failed') THEN
    RAISE EXCEPTION 'Silver issuance attempt binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER alpha_silver_issuance_attempt_guard
  BEFORE UPDATE ON alpha_silver_issuance_attempts
  FOR EACH ROW EXECUTE FUNCTION alpha_silver_issuance_attempt_guard();

COMMIT;
