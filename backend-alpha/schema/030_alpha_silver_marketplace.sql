BEGIN;

-- A user-signed marketplace transaction is durable before broadcast. Chain
-- listing/ownership and finalized transaction remain the settlement authority.
CREATE TABLE alpha_silver_marketplace_submissions (
  signature text PRIMARY KEY CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{80,90}$'),
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  wallet_address text NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  action text NOT NULL CHECK (action IN ('LIST', 'CANCEL', 'BUY')),
  mint_address text NOT NULL CHECK (mint_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  nonce numeric(20,0) NOT NULL CHECK (nonce > 0),
  terms jsonb NOT NULL,
  message_base64 text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, operation_id)
);
CREATE INDEX alpha_silver_marketplace_submissions_mint
  ON alpha_silver_marketplace_submissions (mint_address, recorded_at);

COMMIT;
