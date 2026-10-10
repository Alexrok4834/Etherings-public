BEGIN;

ALTER TABLE alpha_eru_intents
  ADD COLUMN intent_namespace text NOT NULL DEFAULT 'legacy';
ALTER TABLE alpha_eru_intents
  ADD CONSTRAINT alpha_eru_intents_namespace_check
    CHECK (intent_namespace IN ('legacy', 'canonical'));
ALTER TABLE alpha_eru_intents
  DROP CONSTRAINT alpha_eru_intents_account_cluster_nonce_key;
ALTER TABLE alpha_eru_intents
  ADD CONSTRAINT alpha_eru_intents_account_cluster_namespace_nonce_key
    UNIQUE (account_id, cluster, intent_namespace, nonce);

CREATE FUNCTION alpha_eru_intent_namespace_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.intent_namespace IS DISTINCT FROM OLD.intent_namespace THEN
    RAISE EXCEPTION 'ERU intent namespace is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER alpha_eru_intent_namespace_immutable
  BEFORE UPDATE OF intent_namespace ON alpha_eru_intents
  FOR EACH ROW EXECUTE FUNCTION alpha_eru_intent_namespace_immutable();

COMMIT;
