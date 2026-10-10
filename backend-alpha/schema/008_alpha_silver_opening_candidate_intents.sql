BEGIN;

CREATE TABLE alpha_silver_opening_candidate_intents (
  cluster text NOT NULL CHECK (cluster = 'local-validator'),
  genesis_hash text NOT NULL,
  program_id text NOT NULL,
  mint_address text NOT NULL,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id),
  wallet_address text NOT NULL,
  source_token_address text NOT NULL,
  escrow_address text NOT NULL,
  next_operation bigint NOT NULL CHECK (next_operation > 0),
  design_version bigint NOT NULL CHECK (design_version > 0),
  design_commitment text NOT NULL CHECK (design_commitment ~ '^[a-f0-9]{64}$'),
  orao_treasury text NOT NULL,
  seed_hex text NOT NULL CHECK (seed_hex ~ '^[a-f0-9]{64}$' AND seed_hex !~ '^0+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster, genesis_hash, program_id, mint_address),
  UNIQUE (cluster, genesis_hash, program_id, seed_hex)
);

CREATE FUNCTION alpha_silver_candidate_intent_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'candidate Silver opening intent is immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER alpha_silver_candidate_intent_immutable
  BEFORE UPDATE OR DELETE ON alpha_silver_opening_candidate_intents
  FOR EACH ROW EXECUTE FUNCTION alpha_silver_candidate_intent_immutable();

COMMIT;
