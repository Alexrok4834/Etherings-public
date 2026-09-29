BEGIN;

ALTER TABLE alpha_eru_intents
  ADD COLUMN cluster text NOT NULL DEFAULT 'local-validator';
ALTER TABLE alpha_eru_intents
  ALTER COLUMN cluster DROP DEFAULT;
ALTER TABLE alpha_eru_intents
  ADD CONSTRAINT alpha_eru_intents_cluster_check
    CHECK (cluster IN ('local-validator', 'devnet'));
ALTER TABLE alpha_eru_intents
  DROP CONSTRAINT alpha_eru_intents_account_id_nonce_key;
ALTER TABLE alpha_eru_intents
  ADD CONSTRAINT alpha_eru_intents_account_cluster_nonce_key
    UNIQUE (account_id, cluster, nonce);

CREATE FUNCTION alpha_eru_intent_cluster_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cluster IS DISTINCT FROM OLD.cluster THEN
    RAISE EXCEPTION 'ERU intent cluster is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER alpha_eru_intent_cluster_immutable
  BEFORE UPDATE OF cluster ON alpha_eru_intents
  FOR EACH ROW EXECUTE FUNCTION alpha_eru_intent_cluster_immutable();

COMMIT;
