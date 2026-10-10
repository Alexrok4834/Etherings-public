BEGIN;

-- This is an immutable unsigned intent binding, not permission to sign or
-- settle. One operation and one wallet nonce can acquire only one identity.
CREATE TABLE alpha_cooper_level_eru_issuances (
  operation_id uuid PRIMARY KEY REFERENCES alpha_cooper_level_eru_preparations(operation_id)
    ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id) ON DELETE RESTRICT,
  reservation_id uuid NOT NULL UNIQUE REFERENCES alpha_ert_reservations(id) ON DELETE RESTRICT,
  wallet_address text NOT NULL,
  cluster text NOT NULL CHECK (cluster IN ('local-validator', 'devnet')),
  genesis_hash text NOT NULL CHECK (length(genesis_hash) BETWEEN 32 AND 44),
  gateway_program_id text NOT NULL CHECK (length(gateway_program_id) BETWEEN 32 AND 44),
  attestor_address text NOT NULL CHECK (length(attestor_address) BETWEEN 32 AND 44),
  intent_digest char(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  nonce bigint NOT NULL CHECK (nonce > 0),
  config_epoch bigint NOT NULL CHECK (config_epoch > 0),
  expiry_slot bigint NOT NULL CHECK (expiry_slot > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cluster, genesis_hash, gateway_program_id, wallet_address, nonce)
);

CREATE FUNCTION alpha_cooper_level_eru_issuance_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Cooper ERU issuance is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM alpha_cooper_level_eru_preparations p
    JOIN alpha_ert_reservations r ON r.id = p.reservation_id
    WHERE p.operation_id = NEW.operation_id AND p.account_id = NEW.account_id
      AND p.reservation_id = NEW.reservation_id AND p.wallet_address = NEW.wallet_address
      AND p.cluster = NEW.cluster AND p.status = 'prepared' AND r.state = 'held') THEN
    RAISE EXCEPTION 'Cooper ERU issuance does not match prepared hold'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_cooper_level_eru_issuance_guard
  BEFORE INSERT OR UPDATE OR DELETE ON alpha_cooper_level_eru_issuances
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_level_eru_issuance_guard();

COMMIT;
