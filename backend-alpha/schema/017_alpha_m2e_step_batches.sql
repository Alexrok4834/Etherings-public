BEGIN;

CREATE TABLE alpha_m2e_installations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  installation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, installation_id),
  UNIQUE (id, account_id),
  CHECK ((status = 'ACTIVE' AND revoked_at IS NULL) OR
    (status = 'REVOKED' AND revoked_at IS NOT NULL))
);

CREATE TABLE alpha_m2e_batches (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  installation_record_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  local_date date NOT NULL,
  timezone_offset_minutes smallint NOT NULL CHECK (timezone_offset_minutes BETWEEN -1080 AND 1080),
  observed_started_at timestamptz NOT NULL,
  observed_ended_at timestamptz NOT NULL,
  claimed_step_count integer NOT NULL CHECK (claimed_step_count > 0),
  sensor_event_count integer NOT NULL CHECK (sensor_event_count > 0),
  source text NOT NULL CHECK (source = 'android_step_counter'),
  algorithm_version text NOT NULL,
  client_metadata jsonb,
  status text NOT NULL CHECK (status IN ('ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED')),
  accepted_step_delta integer NOT NULL CHECK (accepted_step_delta >= 0 AND
    accepted_step_delta <= claimed_step_count),
  earned_ert_delta numeric(48,18) NOT NULL CHECK (earned_ert_delta >= 0),
  accounting_date date,
  result_code text NOT NULL,
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_record_id, batch_id),
  UNIQUE (installation_record_id, sequence),
  FOREIGN KEY (installation_record_id, account_id)
    REFERENCES alpha_m2e_installations(id, account_id),
  CHECK ((status = 'REJECTED' AND accepted_step_delta = 0 AND earned_ert_delta = 0
      AND accounting_date IS NULL) OR
    (status = 'ACCEPTED' AND accepted_step_delta = claimed_step_count
      AND accounting_date IS NOT NULL) OR
    (status = 'PARTIALLY_ACCEPTED' AND accepted_step_delta > 0
      AND accepted_step_delta < claimed_step_count AND accounting_date IS NOT NULL))
);
CREATE INDEX alpha_m2e_batches_account_interval_idx
  ON alpha_m2e_batches(account_id, observed_started_at, observed_ended_at)
  WHERE status IN ('ACCEPTED', 'PARTIALLY_ACCEPTED');

CREATE FUNCTION alpha_m2e_batch_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'M2E batch result is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER alpha_m2e_batch_immutable
  BEFORE UPDATE OR DELETE ON alpha_m2e_batches
  FOR EACH ROW EXECUTE FUNCTION alpha_m2e_batch_immutable();

COMMIT;
