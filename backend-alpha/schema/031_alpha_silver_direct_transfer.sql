BEGIN;

-- Persist a user-signed NFT transfer before broadcasting. Finalized Token-2022
-- ownership and the existing Silver Ring/Box readers remain authoritative.
CREATE TABLE alpha_silver_direct_transfer_submissions (
  signature text PRIMARY KEY CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{80,90}$'),
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  wallet_address text NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  mint_address text NOT NULL CHECK (mint_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  recipient_address text NOT NULL CHECK (recipient_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  terms jsonb NOT NULL,
  message_base64 text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, operation_id)
);

COMMIT;
