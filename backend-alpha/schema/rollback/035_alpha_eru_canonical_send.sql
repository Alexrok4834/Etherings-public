BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM alpha_eru_intents WHERE intent_namespace = 'canonical') THEN
    RAISE EXCEPTION 'Cannot remove canonical Send intent history';
  END IF;
END $$;

DROP TRIGGER alpha_eru_intent_namespace_immutable ON alpha_eru_intents;
DROP FUNCTION alpha_eru_intent_namespace_immutable();

ALTER TABLE alpha_eru_intents
  DROP CONSTRAINT alpha_eru_intents_account_cluster_namespace_nonce_key;
ALTER TABLE alpha_eru_intents
  ADD CONSTRAINT alpha_eru_intents_account_cluster_nonce_key
    UNIQUE (account_id, cluster, nonce);
ALTER TABLE alpha_eru_intents
  DROP CONSTRAINT alpha_eru_intents_namespace_check;
ALTER TABLE alpha_eru_intents
  DROP COLUMN intent_namespace;

COMMIT;
