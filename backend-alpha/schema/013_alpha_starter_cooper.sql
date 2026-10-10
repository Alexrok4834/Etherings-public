BEGIN;

CREATE TABLE alpha_starter_cooper (
  account_id uuid PRIMARY KEY REFERENCES alpha_accounts(id),
  ring_id uuid NOT NULL UNIQUE,
  audit_id uuid NOT NULL UNIQUE,
  issuance_reason text NOT NULL DEFAULT 'starter' CHECK (issuance_reason = 'starter'),
  generation_version text NOT NULL DEFAULT 'copper-generation-v1'
    CHECK (generation_version = 'copper-generation-v1'),
  visual_set_version text NOT NULL DEFAULT 'copper-visual-v1'
    CHECK (visual_set_version = 'copper-visual-v1'),
  visual_variant_code text NOT NULL CHECK (visual_variant_code IN (
    'copper_plain_polished', 'copper_rune_rough', 'copper_twisted',
    'copper_geometric', 'copper_milgrain', 'copper_leaves',
    'copper_celtic', 'copper_filigree', 'copper_signet')),
  level integer NOT NULL DEFAULT 1 CHECK (level = 1),
  shine integer NOT NULL DEFAULT 100 CHECK (shine = 100),
  comfort integer NOT NULL CHECK (comfort BETWEEN 2 AND 20),
  charm integer NOT NULL CHECK (charm BETWEEN 2 AND 20),
  quality integer NOT NULL CHECK (quality BETWEEN 2 AND 20),
  luck integer NOT NULL CHECK (luck BETWEEN 2 AND 20),
  equipped boolean NOT NULL DEFAULT true CHECK (equipped),
  created_at timestamptz NOT NULL DEFAULT now(),
  equipped_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION alpha_starter_cooper_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'starter Cooper is immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER alpha_starter_cooper_immutable
  BEFORE UPDATE OR DELETE ON alpha_starter_cooper
  FOR EACH ROW EXECUTE FUNCTION alpha_starter_cooper_immutable();

COMMIT;
