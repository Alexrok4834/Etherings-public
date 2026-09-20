CREATE TABLE alpha_eru_intents (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  nonce bigint NOT NULL CHECK (nonce > 0),
  message_base64 text NOT NULL,
  blockhash text NOT NULL,
  last_valid_block_height bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('issued', 'submitting', 'confirmed', 'unknown')),
  transaction_signature text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, nonce)
);

CREATE INDEX alpha_eru_intents_account_idx ON alpha_eru_intents(account_id);
