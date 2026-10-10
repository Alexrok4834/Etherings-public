BEGIN;

ALTER TABLE alpha_silver_opening_candidate_intents
  DROP CONSTRAINT alpha_silver_opening_candidate_intents_cluster_check;
ALTER TABLE alpha_silver_opening_candidate_intents
  ADD CONSTRAINT alpha_silver_opening_candidate_intents_cluster_check
  CHECK (cluster IN ('local-validator', 'devnet'));

COMMIT;
