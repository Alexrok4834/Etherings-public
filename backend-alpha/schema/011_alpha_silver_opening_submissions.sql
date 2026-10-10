BEGIN;

CREATE TABLE alpha_silver_opening_submissions (
  cluster text NOT NULL,
  genesis_hash text NOT NULL,
  program_id text NOT NULL,
  mint_address text NOT NULL,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id),
  wallet_address text NOT NULL,
  message_base64 text NOT NULL,
  blockhash text NOT NULL,
  last_valid_block_height bigint NOT NULL CHECK (last_valid_block_height > 0),
  signature text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'confirmed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY (cluster, genesis_hash, program_id, mint_address),
  FOREIGN KEY (cluster, genesis_hash, program_id, mint_address)
    REFERENCES alpha_silver_opening_candidate_intents (cluster, genesis_hash, program_id, mint_address),
  CONSTRAINT alpha_silver_opening_settled_at CHECK
    ((status = 'unknown' AND settled_at IS NULL) OR
     (status <> 'unknown' AND settled_at IS NOT NULL))
);

CREATE FUNCTION alpha_silver_opening_submission_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.cluster, OLD.genesis_hash, OLD.program_id, OLD.mint_address,
         OLD.account_id, OLD.wallet_address, OLD.message_base64, OLD.blockhash,
         OLD.last_valid_block_height, OLD.signature, OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.cluster, NEW.genesis_hash, NEW.program_id, NEW.mint_address,
         NEW.account_id, NEW.wallet_address, NEW.message_base64, NEW.blockhash,
         NEW.last_valid_block_height, NEW.signature, NEW.created_at)
     OR OLD.status <> 'unknown' OR NEW.status NOT IN ('confirmed', 'failed') THEN
    RAISE EXCEPTION 'Silver opening submission binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER alpha_silver_opening_submission_guard
  BEFORE UPDATE ON alpha_silver_opening_submissions
  FOR EACH ROW EXECUTE FUNCTION alpha_silver_opening_submission_guard();

COMMIT;
