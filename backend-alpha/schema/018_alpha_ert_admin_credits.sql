BEGIN;

ALTER TABLE alpha_accounts ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

CREATE TABLE alpha_ert_admin_credits (
  id uuid PRIMARY KEY,
  actor_account_id uuid NOT NULL REFERENCES alpha_accounts(id),
  target_account_id uuid NOT NULL REFERENCES alpha_accounts(id),
  amount numeric(48,18) NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 512),
  ledger_id uuid NOT NULL UNIQUE REFERENCES alpha_ert_ledger(id),
  result_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alpha_ert_admin_credits_target_idx
  ON alpha_ert_admin_credits(target_account_id, created_at);

CREATE FUNCTION alpha_ert_admin_credit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ERT admin credit audit is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER alpha_ert_admin_credit_immutable
  BEFORE UPDATE OR DELETE ON alpha_ert_admin_credits
  FOR EACH ROW EXECUTE FUNCTION alpha_ert_admin_credit_immutable();

COMMIT;
