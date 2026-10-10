CREATE TABLE alpha_wallet_bindings (
  account_id uuid PRIMARY KEY REFERENCES alpha_accounts(id) ON DELETE CASCADE,
  wallet_address text NOT NULL UNIQUE,
  environment text NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alpha_wallet_binding_challenges (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[a-f0-9]{64}$'),
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  environment text NOT NULL,
  issued_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms > issued_at_ms),
  consumed_at_ms bigint,
  CONSTRAINT alpha_wallet_challenge_consumed_after_issue
    CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= issued_at_ms)
);

CREATE INDEX alpha_wallet_challenge_account_idx
  ON alpha_wallet_binding_challenges(account_id);
