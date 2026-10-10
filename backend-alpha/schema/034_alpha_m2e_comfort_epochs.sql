BEGIN;

-- A bounded cutover: pre-existing un-attributed offline batches must not be
-- priced from a later Ring state when no immutable daily snapshot exists.
CREATE TABLE alpha_m2e_comfort_cutover (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO alpha_m2e_comfort_cutover (id) VALUES (true);

CREATE TABLE alpha_m2e_comfort_changes (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  source_key text NOT NULL,
  previous_ring_kind text CHECK (previous_ring_kind IN ('COOPER', 'SILVER_RING')),
  previous_ring_id text,
  previous_comfort integer CHECK (previous_comfort >= 0),
  current_ring_kind text NOT NULL CHECK (current_ring_kind IN ('COOPER', 'SILVER_RING')),
  current_ring_id text NOT NULL,
  current_comfort integer NOT NULL CHECK (current_comfort >= 0),
  uncertain_started_at timestamptz NOT NULL,
  effective_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id, source_key),
  CHECK ((previous_ring_kind IS NULL) = (previous_ring_id IS NULL)),
  CHECK (uncertain_started_at <= effective_at)
);
CREATE INDEX alpha_m2e_comfort_changes_timeline
  ON alpha_m2e_comfort_changes(account_id, effective_at, id);

CREATE TABLE alpha_m2e_comfort_segments (
  account_id uuid NOT NULL,
  accounting_date date NOT NULL,
  segment_key text NOT NULL,
  selected_ring_kind text NOT NULL CHECK (selected_ring_kind IN ('COOPER', 'SILVER_RING')),
  selected_ring_id text NOT NULL,
  comfort integer NOT NULL CHECK (comfort >= 0),
  accepted_steps integer NOT NULL DEFAULT 0 CHECK (accepted_steps >= 0),
  earned_ert numeric(48,18) NOT NULL DEFAULT 0 CHECK (earned_ert >= 0),
  PRIMARY KEY (account_id, accounting_date, segment_key),
  FOREIGN KEY (account_id, accounting_date)
    REFERENCES alpha_m2e_daily_stats(account_id, accounting_date) ON DELETE RESTRICT
);

CREATE FUNCTION alpha_m2e_comfort_change_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'M2E Comfort change is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER alpha_m2e_comfort_change_immutable
  BEFORE UPDATE OR DELETE ON alpha_m2e_comfort_changes
  FOR EACH ROW EXECUTE FUNCTION alpha_m2e_comfort_change_immutable();

COMMIT;
