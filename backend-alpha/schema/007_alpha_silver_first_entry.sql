BEGIN;

CREATE TABLE alpha_silver_first_entry (
  account_id uuid NOT NULL REFERENCES alpha_accounts(id),
  wallet_address text NOT NULL,
  cluster text NOT NULL CHECK (cluster IN ('local-validator', 'devnet')),
  issuance_source text NOT NULL DEFAULT 'first-entry' CHECK (issuance_source = 'first-entry'),
  issuance_id text NOT NULL CHECK (issuance_id ~ '^[a-f0-9]{64}$'),
  entitlement_digest text NOT NULL CHECK (entitlement_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'unknown', 'confirmed')),
  mint_address text,
  finalized_signature text,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  PRIMARY KEY (account_id, cluster),
  UNIQUE (cluster, issuance_id),
  UNIQUE (cluster, entitlement_digest),
  CONSTRAINT alpha_silver_confirmation_complete CHECK (
    (status = 'confirmed') = (mint_address IS NOT NULL AND finalized_signature IS NOT NULL AND confirmed_at IS NOT NULL)
  )
);

CREATE FUNCTION alpha_silver_entitlement_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.account_id, NEW.wallet_address, NEW.cluster, NEW.issuance_source,
      NEW.issuance_id, NEW.entitlement_digest) IS DISTINCT FROM
     (OLD.account_id, OLD.wallet_address, OLD.cluster, OLD.issuance_source,
      OLD.issuance_id, OLD.entitlement_digest) THEN
    RAISE EXCEPTION 'silver entitlement binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'confirmed' AND
     (NEW.status, NEW.mint_address, NEW.finalized_signature, NEW.confirmed_at)
       IS DISTINCT FROM
     (OLD.status, OLD.mint_address, OLD.finalized_signature, OLD.confirmed_at) THEN
    RAISE EXCEPTION 'confirmed silver entitlement is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER alpha_silver_entitlement_immutable
  BEFORE UPDATE ON alpha_silver_first_entry
  FOR EACH ROW EXECUTE FUNCTION alpha_silver_entitlement_immutable();

COMMIT;
