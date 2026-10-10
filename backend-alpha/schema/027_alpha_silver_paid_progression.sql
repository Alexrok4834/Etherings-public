BEGIN;

-- Preserve all existing Silver preparations and immutable settlement evidence.
-- Paid transitions retain the same one-operation ERT hold and audit path.
DO $$
DECLARE restricted_check text;
BEGIN
  SELECT conname INTO STRICT restricted_check FROM pg_constraint
  WHERE conrelid = 'alpha_silver_progression_operations'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%target_level%'
    AND pg_get_constraintdef(oid) LIKE '%5%'
    AND pg_get_constraintdef(oid) LIKE '%20%';
  EXECUTE format('ALTER TABLE alpha_silver_progression_operations DROP CONSTRAINT %I',
    restricted_check);
END $$;

ALTER TABLE alpha_silver_progression_operations
  ADD COLUMN eru_principal numeric(48,9) NOT NULL DEFAULT 0,
  ADD COLUMN eru_fee numeric(48,9) NOT NULL DEFAULT 0,
  ADD CONSTRAINT alpha_silver_progression_paid_price CHECK (
    (target_level = 5 AND eru_principal = 38 AND eru_fee = 0.76) OR
    (target_level = 20 AND eru_principal = 75 AND eru_fee = 1.50) OR
    (target_level NOT IN (5, 20) AND eru_principal = 0 AND eru_fee = 0)
  );

ALTER TABLE alpha_silver_progression_submissions
  ADD COLUMN gateway_config_base64 text;

COMMIT;
