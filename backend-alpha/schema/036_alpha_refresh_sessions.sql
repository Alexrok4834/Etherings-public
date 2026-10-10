BEGIN;

ALTER TABLE alpha_sessions ADD COLUMN family_id uuid;

CREATE TABLE alpha_refresh_tokens (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  installation_record_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  parent_token_id uuid REFERENCES alpha_refresh_tokens(id),
  replaced_by_token_id uuid,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'ROTATED', 'REVOKED')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (installation_record_id, account_id)
    REFERENCES alpha_m2e_installations(id, account_id)
);

CREATE INDEX alpha_refresh_tokens_family_idx ON alpha_refresh_tokens(family_id);
CREATE INDEX alpha_refresh_tokens_account_idx ON alpha_refresh_tokens(account_id);
CREATE INDEX alpha_sessions_family_idx ON alpha_sessions(family_id);
CREATE UNIQUE INDEX alpha_refresh_tokens_one_active_family
  ON alpha_refresh_tokens(family_id) WHERE status = 'ACTIVE';

COMMIT;
