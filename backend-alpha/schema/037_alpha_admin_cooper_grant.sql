BEGIN;

-- One-off owner-directed Cooper grant with explicit provenance. Never claim a Draw result.
CREATE TABLE alpha_admin_cooper_rings (
  ring_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES alpha_accounts(id),
  actor_account_id uuid NOT NULL REFERENCES alpha_accounts(id),
  operation_id uuid NOT NULL UNIQUE,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 512),
  source_ring_id uuid NOT NULL,
  issuance_reason text NOT NULL DEFAULT 'admin-report'
    CHECK (issuance_reason = 'admin-report'),
  visual_set_version text NOT NULL DEFAULT 'copper-visual-v1'
    CHECK (visual_set_version = 'copper-visual-v1'),
  visual_variant_code text NOT NULL CHECK (visual_variant_code IN (
    'copper_plain_polished', 'copper_rune_rough', 'copper_twisted',
    'copper_geometric', 'copper_milgrain', 'copper_leaves',
    'copper_celtic', 'copper_filigree', 'copper_signet')),
  comfort integer NOT NULL CHECK (comfort BETWEEN 2 AND 20),
  charm integer NOT NULL CHECK (charm BETWEEN 2 AND 20),
  quality integer NOT NULL CHECK (quality BETWEEN 2 AND 20),
  luck integer NOT NULL CHECK (luck BETWEEN 2 AND 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, ring_id),
  FOREIGN KEY (account_id, source_ring_id)
    REFERENCES alpha_starter_cooper(account_id, ring_id)
);

CREATE FUNCTION alpha_admin_cooper_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Admin Cooper grant is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER alpha_admin_cooper_immutable
  BEFORE UPDATE OR DELETE ON alpha_admin_cooper_rings
  FOR EACH ROW EXECUTE FUNCTION alpha_admin_cooper_immutable();

CREATE OR REPLACE FUNCTION alpha_cooper_current_owner_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM alpha_starter_cooper
      WHERE account_id = NEW.account_id AND ring_id = NEW.ring_id)
      AND NOT EXISTS (SELECT 1 FROM alpha_draw_cooper_rings
      WHERE account_id = NEW.account_id AND ring_id = NEW.ring_id)
      AND NOT EXISTS (SELECT 1 FROM alpha_admin_cooper_rings
      WHERE account_id = NEW.account_id AND ring_id = NEW.ring_id) THEN
    RAISE EXCEPTION 'Cooper current state requires owned Ring provenance'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION alpha_ring_selection_cooper_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ring_kind = 'COOPER' AND NOT EXISTS (
    SELECT 1 FROM alpha_starter_cooper
    WHERE account_id = NEW.account_id AND ring_id::text = NEW.ring_id
  ) AND NOT EXISTS (
    SELECT 1 FROM alpha_draw_cooper_rings
    WHERE account_id = NEW.account_id AND ring_id::text = NEW.ring_id
  ) AND NOT EXISTS (
    SELECT 1 FROM alpha_admin_cooper_rings
    WHERE account_id = NEW.account_id AND ring_id::text = NEW.ring_id
  ) THEN
    RAISE EXCEPTION 'Cooper Ring is not owned by selection account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
