BEGIN;

ALTER TABLE alpha_eru_intents DROP CONSTRAINT alpha_eru_intents_status_check;
UPDATE alpha_eru_intents SET status = 'pending' WHERE status = 'issued';
UPDATE alpha_eru_intents SET status = 'unknown' WHERE status = 'submitting';
ALTER TABLE alpha_eru_intents
  ADD CONSTRAINT alpha_eru_intents_status_check
  CHECK (status IN ('pending', 'confirmed', 'failed', 'unknown'));

CREATE UNIQUE INDEX alpha_eru_intents_cluster_signature_key
  ON alpha_eru_intents (cluster, transaction_signature)
  WHERE transaction_signature IS NOT NULL;

COMMIT;
