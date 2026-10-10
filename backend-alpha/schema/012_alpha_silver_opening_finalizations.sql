BEGIN;

CREATE TABLE alpha_silver_opening_finalizations (
  cluster text NOT NULL CHECK (cluster = 'devnet'),
  genesis_hash text NOT NULL,
  program_id text NOT NULL,
  mint_address text NOT NULL,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id),
  wallet_address text NOT NULL,
  operation_address text NOT NULL,
  request_address text NOT NULL,
  ring_mint_address text NOT NULL,
  payer_address text NOT NULL,
  message_base64 text NOT NULL,
  blockhash text NOT NULL,
  last_valid_block_height bigint NOT NULL CHECK (last_valid_block_height > 0),
  signature text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'confirmed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY (cluster, genesis_hash, program_id, mint_address),
  FOREIGN KEY (cluster, genesis_hash, program_id, mint_address)
    REFERENCES alpha_silver_opening_submissions (cluster, genesis_hash, program_id, mint_address),
  CONSTRAINT alpha_silver_finalization_settled_at CHECK
    ((status = 'unknown' AND settled_at IS NULL) OR
     (status <> 'unknown' AND settled_at IS NOT NULL))
);

CREATE FUNCTION alpha_silver_finalization_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.cluster, OLD.genesis_hash, OLD.program_id, OLD.mint_address,
         OLD.account_id, OLD.wallet_address, OLD.operation_address, OLD.request_address,
         OLD.ring_mint_address, OLD.payer_address, OLD.message_base64, OLD.blockhash,
         OLD.last_valid_block_height, OLD.signature, OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.cluster, NEW.genesis_hash, NEW.program_id, NEW.mint_address,
         NEW.account_id, NEW.wallet_address, NEW.operation_address, NEW.request_address,
         NEW.ring_mint_address, NEW.payer_address, NEW.message_base64, NEW.blockhash,
         NEW.last_valid_block_height, NEW.signature, NEW.created_at)
     OR OLD.status <> 'unknown' OR NEW.status NOT IN ('confirmed', 'failed') THEN
    RAISE EXCEPTION 'Silver finalization binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER alpha_silver_finalization_guard
  BEFORE UPDATE ON alpha_silver_opening_finalizations
  FOR EACH ROW EXECUTE FUNCTION alpha_silver_finalization_guard();

COMMIT;
