BEGIN;

CREATE TABLE alpha_m2e_daily_snapshots (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  accounting_date date NOT NULL,
  selected_ring_kind text NOT NULL CHECK (selected_ring_kind IN ('COOPER', 'SILVER_RING')),
  selected_ring_id text NOT NULL,
  ring_count integer NOT NULL CHECK (ring_count > 0),
  selected_ring_comfort integer NOT NULL CHECK (selected_ring_comfort >= 0),
  step_cap integer NOT NULL CHECK (step_cap > 0),
  rules_version text NOT NULL CHECK (rules_version = 'move-to-earn-earning-v1'),
  balance_config_version text NOT NULL CHECK (balance_config_version = 'move-to-earn-balance-v1'),
  base_steps integer NOT NULL CHECK (base_steps > 0),
  extra_steps_per_ring integer NOT NULL CHECK (extra_steps_per_ring > 0),
  base_ert_per_1000_steps numeric(48,18) NOT NULL CHECK (base_ert_per_1000_steps >= 0),
  comfort_curve_k integer NOT NULL CHECK (comfort_curve_k > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, accounting_date),
  UNIQUE (id, account_id)
);

CREATE TABLE alpha_m2e_daily_stats (
  account_id uuid NOT NULL,
  accounting_date date NOT NULL,
  snapshot_id uuid NOT NULL,
  accepted_steps integer NOT NULL DEFAULT 0 CHECK (accepted_steps >= 0),
  earned_ert numeric(48,18) NOT NULL DEFAULT 0 CHECK (earned_ert >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, accounting_date),
  FOREIGN KEY (snapshot_id, account_id) REFERENCES alpha_m2e_daily_snapshots(id, account_id)
);

CREATE TABLE alpha_m2e_settlements (
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  snapshot_id uuid NOT NULL,
  accepted_step_delta integer NOT NULL CHECK (accepted_step_delta > 0),
  earned_ert_delta numeric(48,18) NOT NULL CHECK (earned_ert_delta >= 0),
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, batch_id),
  FOREIGN KEY (snapshot_id, account_id) REFERENCES alpha_m2e_daily_snapshots(id, account_id)
);

CREATE FUNCTION alpha_m2e_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'M2E daily snapshot is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER alpha_m2e_snapshot_immutable
  BEFORE UPDATE OR DELETE ON alpha_m2e_daily_snapshots
  FOR EACH ROW EXECUTE FUNCTION alpha_m2e_snapshot_immutable();
CREATE TRIGGER alpha_m2e_settlement_immutable
  BEFORE UPDATE OR DELETE ON alpha_m2e_settlements
  FOR EACH ROW EXECUTE FUNCTION alpha_m2e_snapshot_immutable();

COMMIT;
