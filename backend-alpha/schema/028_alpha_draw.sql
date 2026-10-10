BEGIN;

-- Alpha adaptation of the MVP Raffle v2 versioned configuration and immutable
-- operation/result evidence. No existing Draw, ledger or starter rows are rewritten.
CREATE TABLE alpha_draw_configurations (
  id uuid PRIMARY KEY,
  contract_version text NOT NULL DEFAULT 'raffle-v2'
    CHECK (contract_version = 'raffle-v2'),
  status text NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'DISABLED')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 128),
  cost_ert numeric(48,18) NOT NULL CHECK (cost_ert = 5),
  daily_user_attempt_limit smallint NOT NULL
    CHECK (daily_user_attempt_limit BETWEEN 1 AND 32767),
  created_by_account_id uuid NOT NULL REFERENCES alpha_accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  disabled_at timestamptz,
  CHECK ((status = 'DRAFT' AND activated_at IS NULL AND disabled_at IS NULL)
    OR (status = 'ACTIVE' AND activated_at IS NOT NULL AND disabled_at IS NULL)
    OR (status = 'DISABLED' AND activated_at IS NOT NULL
      AND disabled_at IS NOT NULL AND disabled_at >= activated_at))
);
CREATE UNIQUE INDEX alpha_draw_one_active_configuration
  ON alpha_draw_configurations ((true)) WHERE status = 'ACTIVE';

CREATE TABLE alpha_draw_configuration_rewards (
  configuration_id uuid NOT NULL REFERENCES alpha_draw_configurations(id),
  reward_id uuid NOT NULL,
  segment_index smallint NOT NULL CHECK (segment_index BETWEEN 0 AND 3),
  reward_type text NOT NULL CHECK (reward_type IN
    ('ERT', 'ERU', 'COPPER_RING', 'SILVER_BOX')),
  weight integer NOT NULL CHECK (weight > 0),
  amount_exact numeric(48,18),
  reward_snapshot jsonb NOT NULL CHECK (jsonb_typeof(reward_snapshot) = 'object'),
  PRIMARY KEY (configuration_id, reward_id),
  UNIQUE (configuration_id, segment_index),
  UNIQUE (configuration_id, reward_type),
  CHECK ((reward_type = 'ERT' AND amount_exact = 10)
    OR (reward_type = 'ERU' AND amount_exact = 5)
    OR (reward_type IN ('COPPER_RING', 'SILVER_BOX') AND amount_exact IS NULL))
);

CREATE FUNCTION alpha_draw_guard_configuration() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE guarded_configuration_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'alpha_draw_configuration_rewards' THEN
    IF TG_OP = 'DELETE' THEN
      guarded_configuration_id := OLD.configuration_id;
    ELSE
      guarded_configuration_id := NEW.configuration_id;
    END IF;
    IF EXISTS (SELECT 1 FROM alpha_draw_configurations WHERE id =
      guarded_configuration_id AND status <> 'DRAFT') THEN
      RAISE EXCEPTION 'active Draw rewards are immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.configuration_id <> NEW.configuration_id THEN
      RAISE EXCEPTION 'Draw reward configuration binding is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Draw configuration history is immutable' USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW.contract_version, NEW.created_by_account_id, NEW.created_at)
      IS DISTINCT FROM
      (OLD.id, OLD.contract_version, OLD.created_by_account_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Draw configuration identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'DRAFT' AND (NEW.id, NEW.contract_version, NEW.title,
      NEW.cost_ert, NEW.daily_user_attempt_limit, NEW.created_by_account_id,
      NEW.created_at, NEW.activated_at) IS DISTINCT FROM
      (OLD.id, OLD.contract_version, OLD.title, OLD.cost_ert,
      OLD.daily_user_attempt_limit, OLD.created_by_account_id,
      OLD.created_at, OLD.activated_at) THEN
    RAISE EXCEPTION 'activated Draw economy is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE') OR
      (OLD.status = 'ACTIVE' AND NEW.status = 'DISABLED') OR
      (OLD.status = NEW.status AND OLD.status = 'DRAFT')) THEN
    RAISE EXCEPTION 'invalid Draw configuration transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE' AND
      (SELECT count(*) FROM alpha_draw_configuration_rewards
       WHERE configuration_id = OLD.id) <> 4 THEN
    RAISE EXCEPTION 'Alpha Draw requires four rewards' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_draw_config_guard
  BEFORE UPDATE OR DELETE ON alpha_draw_configurations
  FOR EACH ROW EXECUTE FUNCTION alpha_draw_guard_configuration();
CREATE TRIGGER alpha_draw_reward_guard
  BEFORE INSERT OR UPDATE OR DELETE ON alpha_draw_configuration_rewards
  FOR EACH ROW EXECUTE FUNCTION alpha_draw_guard_configuration();

CREATE TABLE alpha_draw_operations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id),
  idempotency_key uuid NOT NULL,
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  configuration_id uuid NOT NULL REFERENCES alpha_draw_configurations(id),
  wallet_address text NOT NULL,
  utc_day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key),
  UNIQUE (id, account_id)
);
CREATE INDEX alpha_draw_daily_attempts
  ON alpha_draw_operations(account_id, utc_day);

CREATE TABLE alpha_draw_results (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE REFERENCES alpha_draw_operations(id),
  account_id uuid NOT NULL REFERENCES alpha_accounts(id),
  configuration_id uuid NOT NULL REFERENCES alpha_draw_configurations(id),
  selected_reward_id uuid NOT NULL,
  selected_reward_type text NOT NULL CHECK (selected_reward_type IN
    ('ERT', 'ERU', 'COPPER_RING', 'SILVER_BOX')),
  selected_segment_index smallint NOT NULL CHECK (selected_segment_index BETWEEN 0 AND 3),
  algorithm text NOT NULL CHECK (algorithm = 'CSPRNG_UNBIASED_INT_V1'),
  ticket integer NOT NULL CHECK (ticket >= 0),
  total_weight integer NOT NULL CHECK (total_weight > ticket),
  ranges_snapshot jsonb NOT NULL CHECK (jsonb_typeof(ranges_snapshot) = 'array'),
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (configuration_id, selected_reward_id)
    REFERENCES alpha_draw_configuration_rewards(configuration_id, reward_id),
  FOREIGN KEY (operation_id, account_id)
    REFERENCES alpha_draw_operations(id, account_id)
);
CREATE INDEX alpha_draw_result_history ON alpha_draw_results(account_id, created_at DESC, id DESC);

-- MVP raffle-owned Cooper provenance, separate from immutable starter issuance.
CREATE TABLE alpha_draw_cooper_rings (
  ring_id uuid PRIMARY KEY,
  result_id uuid NOT NULL UNIQUE REFERENCES alpha_draw_results(id),
  account_id uuid NOT NULL REFERENCES alpha_accounts(id),
  issuance_reason text NOT NULL DEFAULT 'raffle' CHECK (issuance_reason = 'raffle'),
  generation_version text NOT NULL DEFAULT 'copper-generation-v1'
    CHECK (generation_version = 'copper-generation-v1'),
  visual_set_version text NOT NULL DEFAULT 'copper-visual-v1'
    CHECK (visual_set_version = 'copper-visual-v1'),
  visual_variant_code text NOT NULL CHECK (visual_variant_code IN (
    'copper_plain_polished', 'copper_rune_rough', 'copper_twisted',
    'copper_geometric', 'copper_milgrain', 'copper_leaves',
    'copper_celtic', 'copper_filigree', 'copper_signet')),
  comfort integer NOT NULL CHECK (comfort BETWEEN 2 AND 20),
  charm integer NOT NULL CHECK (charm BETWEEN 2 AND 20),
  quality integer NOT NULL CHECK (quality BETWEEN 2 AND 20),
  luck integer NOT NULL CHECK (luck BETWEEN 2 AND 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, ring_id)
);
CREATE FUNCTION alpha_draw_cooper_provenance_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Draw Cooper provenance is immutable' USING ERRCODE = '23514';
  END IF;
  IF (NEW.ring_id, NEW.result_id, NEW.account_id, NEW.issuance_reason,
       NEW.generation_version, NEW.visual_set_version, NEW.visual_variant_code,
       NEW.comfort, NEW.charm, NEW.quality, NEW.luck, NEW.created_at)
      IS DISTINCT FROM
      (OLD.ring_id, OLD.result_id, OLD.account_id, OLD.issuance_reason,
       OLD.generation_version, OLD.visual_set_version, OLD.visual_variant_code,
       OLD.comfort, OLD.charm, OLD.quality, OLD.luck, OLD.created_at) THEN
    RAISE EXCEPTION 'Draw Cooper provenance is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_draw_cooper_provenance_guard
  BEFORE UPDATE OR DELETE ON alpha_draw_cooper_rings
  FOR EACH ROW EXECUTE FUNCTION alpha_draw_cooper_provenance_immutable();

-- 019's one-starter account PK/FK was a starter-flow storage constraint, not
-- Cooper's product limit. Reuse the same current-state/progression table and
-- its operation FKs, now keyed by the owned Ring identity.
ALTER TABLE alpha_cooper_current_state
  DROP CONSTRAINT alpha_cooper_current_state_account_id_ring_id_fkey;
ALTER TABLE alpha_cooper_current_state
  DROP CONSTRAINT alpha_cooper_current_state_pkey;
ALTER TABLE alpha_cooper_current_state
  ADD CONSTRAINT alpha_cooper_current_state_pk PRIMARY KEY (account_id, ring_id);
CREATE FUNCTION alpha_cooper_current_owner_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM alpha_starter_cooper
      WHERE account_id = NEW.account_id AND ring_id = NEW.ring_id)
      AND NOT EXISTS (SELECT 1 FROM alpha_draw_cooper_rings
      WHERE account_id = NEW.account_id AND ring_id = NEW.ring_id) THEN
    RAISE EXCEPTION 'Cooper current state requires owned Ring provenance'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_cooper_current_owner_guard
  BEFORE INSERT ON alpha_cooper_current_state
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_current_owner_guard();

-- Extend the existing mixed Equip ownership gate without changing starter 013.
CREATE OR REPLACE FUNCTION alpha_ring_selection_cooper_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ring_kind = 'COOPER' AND NOT EXISTS (
    SELECT 1 FROM alpha_starter_cooper
    WHERE account_id = NEW.account_id AND ring_id::text = NEW.ring_id
  ) AND NOT EXISTS (
    SELECT 1 FROM alpha_draw_cooper_rings
    WHERE account_id = NEW.account_id AND ring_id::text = NEW.ring_id
  ) THEN
    RAISE EXCEPTION 'Cooper Ring is not owned by selection account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE alpha_draw_cooper_events (
  id uuid PRIMARY KEY,
  ring_id uuid NOT NULL UNIQUE REFERENCES alpha_draw_cooper_rings(ring_id),
  result_id uuid NOT NULL UNIQUE REFERENCES alpha_draw_results(id),
  account_id uuid NOT NULL REFERENCES alpha_accounts(id),
  event_type text NOT NULL CHECK (event_type = 'RAFFLE_AWARDED'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alpha_draw_fulfillments (
  result_id uuid PRIMARY KEY REFERENCES alpha_draw_results(id),
  reward_type text NOT NULL CHECK (reward_type IN
    ('ERT', 'ERU', 'COPPER_RING', 'SILVER_BOX')),
  state text NOT NULL CHECK (state IN ('PENDING', 'UNKNOWN', 'CONFIRMED')),
  ledger_id uuid REFERENCES alpha_ert_ledger(id),
  cooper_ring_id uuid REFERENCES alpha_draw_cooper_rings(ring_id),
  chain_signature text,
  chain_asset_address text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((reward_type = 'ERT' AND state = 'CONFIRMED' AND ledger_id IS NOT NULL
      AND cooper_ring_id IS NULL AND chain_signature IS NULL)
    OR (reward_type = 'COPPER_RING' AND state = 'CONFIRMED'
      AND cooper_ring_id IS NOT NULL AND ledger_id IS NULL AND chain_signature IS NULL)
    OR (reward_type IN ('ERU', 'SILVER_BOX') AND ledger_id IS NULL
      AND cooper_ring_id IS NULL))
);

CREATE TABLE alpha_draw_chain_attempts (
  result_id uuid NOT NULL REFERENCES alpha_draw_results(id),
  leg text NOT NULL CHECK (leg IN ('ERU_GRANT', 'ERU_CLAIM', 'BOX_ISSUE')),
  attempt integer NOT NULL CHECK (attempt > 0),
  signature text NOT NULL UNIQUE,
  raw_transaction_base64 text NOT NULL,
  blockhash text NOT NULL,
  last_valid_block_height bigint NOT NULL CHECK (last_valid_block_height > 0),
  mint_address text,
  state text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (state IN ('UNKNOWN', 'CONFIRMED', 'FAILED', 'EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY (result_id, leg, attempt),
  CHECK ((state = 'UNKNOWN' AND settled_at IS NULL) OR
    (state <> 'UNKNOWN' AND settled_at IS NOT NULL))
);
CREATE UNIQUE INDEX alpha_draw_one_unknown_chain_attempt
  ON alpha_draw_chain_attempts(result_id, leg) WHERE state = 'UNKNOWN';

CREATE FUNCTION alpha_draw_guard_fulfillment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Draw fulfillment history is immutable' USING ERRCODE = '23514';
  END IF;
  IF (NEW.result_id, NEW.reward_type, NEW.ledger_id, NEW.cooper_ring_id)
      IS DISTINCT FROM
      (OLD.result_id, OLD.reward_type, OLD.ledger_id, OLD.cooper_ring_id) OR
      OLD.state = 'CONFIRMED' OR
      (OLD.state = 'PENDING' AND NEW.state NOT IN ('PENDING', 'UNKNOWN', 'CONFIRMED')) OR
      (OLD.state = 'UNKNOWN' AND NEW.state NOT IN ('UNKNOWN', 'CONFIRMED')) OR
      (OLD.chain_signature IS NOT NULL AND NEW.chain_signature IS DISTINCT FROM OLD.chain_signature) OR
      (OLD.chain_asset_address IS NOT NULL AND
        NEW.chain_asset_address IS DISTINCT FROM OLD.chain_asset_address) THEN
    RAISE EXCEPTION 'Draw fulfillment binding or terminal state is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_draw_fulfillment_guard
  BEFORE UPDATE OR DELETE ON alpha_draw_fulfillments
  FOR EACH ROW EXECUTE FUNCTION alpha_draw_guard_fulfillment();

CREATE FUNCTION alpha_draw_guard_chain_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Draw chain attempt history is immutable' USING ERRCODE = '23514';
  END IF;
  IF (NEW.result_id, NEW.leg, NEW.attempt, NEW.signature,
       NEW.raw_transaction_base64, NEW.blockhash,
       NEW.last_valid_block_height, NEW.mint_address, NEW.created_at)
      IS DISTINCT FROM
      (OLD.result_id, OLD.leg, OLD.attempt, OLD.signature,
       OLD.raw_transaction_base64, OLD.blockhash,
       OLD.last_valid_block_height, OLD.mint_address, OLD.created_at) OR
      OLD.state <> 'UNKNOWN' OR NEW.state NOT IN
        ('UNKNOWN', 'CONFIRMED', 'FAILED', 'EXPIRED') THEN
    RAISE EXCEPTION 'Draw chain attempt evidence is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_draw_chain_attempt_guard
  BEFORE UPDATE OR DELETE ON alpha_draw_chain_attempts
  FOR EACH ROW EXECUTE FUNCTION alpha_draw_guard_chain_attempt();

CREATE FUNCTION alpha_draw_immutable_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Draw operation/result evidence is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER alpha_draw_operation_immutable
  BEFORE UPDATE OR DELETE ON alpha_draw_operations
  FOR EACH ROW EXECUTE FUNCTION alpha_draw_immutable_evidence();
CREATE TRIGGER alpha_draw_result_immutable
  BEFORE UPDATE OR DELETE ON alpha_draw_results
  FOR EACH ROW EXECUTE FUNCTION alpha_draw_immutable_evidence();
CREATE TRIGGER alpha_draw_cooper_event_immutable
  BEFORE UPDATE OR DELETE ON alpha_draw_cooper_events
  FOR EACH ROW EXECUTE FUNCTION alpha_draw_immutable_evidence();

COMMIT;
