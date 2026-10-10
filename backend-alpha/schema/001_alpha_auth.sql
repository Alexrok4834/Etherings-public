CREATE TABLE alpha_accounts (
  id uuid PRIMARY KEY,
  email_normalized text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alpha_email_normalized CHECK (email_normalized = lower(trim(email_normalized)))
);

CREATE TABLE alpha_email_challenges (
  account_id uuid PRIMARY KEY REFERENCES alpha_accounts(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sent_at timestamptz NOT NULL
);

CREATE TABLE alpha_rate_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count >= 0)
);

CREATE TABLE alpha_sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
