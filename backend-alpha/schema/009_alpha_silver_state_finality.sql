BEGIN;

ALTER TABLE alpha_silver_first_entry
  ADD COLUMN confirmation_slot numeric(20, 0)
    CHECK (confirmation_slot IS NULL OR confirmation_slot > 0);

ALTER TABLE alpha_silver_first_entry
  DROP CONSTRAINT alpha_silver_confirmation_complete;

ALTER TABLE alpha_silver_first_entry
  ADD CONSTRAINT alpha_silver_confirmation_complete CHECK (
    (status = 'confirmed') =
      (mint_address IS NOT NULL AND confirmed_at IS NOT NULL AND
       (finalized_signature IS NOT NULL OR confirmation_slot IS NOT NULL))
  );

CREATE OR REPLACE FUNCTION alpha_silver_entitlement_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.account_id, NEW.wallet_address, NEW.cluster, NEW.issuance_source,
      NEW.issuance_id, NEW.entitlement_digest) IS DISTINCT FROM
     (OLD.account_id, OLD.wallet_address, OLD.cluster, OLD.issuance_source,
      OLD.issuance_id, OLD.entitlement_digest) THEN
    RAISE EXCEPTION 'silver entitlement binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'confirmed' AND
     (NEW.status, NEW.mint_address, NEW.finalized_signature, NEW.confirmed_at,
      NEW.confirmation_slot) IS DISTINCT FROM
     (OLD.status, OLD.mint_address, OLD.finalized_signature, OLD.confirmed_at,
      OLD.confirmation_slot) THEN
    RAISE EXCEPTION 'confirmed silver entitlement is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
