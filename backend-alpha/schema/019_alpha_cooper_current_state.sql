BEGIN;

-- 013 remains the immutable issuance/initial-generation fact. Current gameplay
-- state has the same owner and Ring identity but may progress independently.
ALTER TABLE alpha_starter_cooper
  ADD CONSTRAINT alpha_starter_cooper_account_ring_unique UNIQUE (account_id, ring_id);

CREATE TABLE alpha_cooper_current_state (
  account_id uuid PRIMARY KEY,
  ring_id uuid NOT NULL UNIQUE,
  level integer NOT NULL CHECK (level BETWEEN 1 AND 20),
  shine integer NOT NULL CHECK (shine >= 0),
  comfort integer NOT NULL CHECK (comfort >= 2),
  charm integer NOT NULL CHECK (charm >= 2),
  quality integer NOT NULL CHECK (quality >= 2),
  luck integer NOT NULL CHECK (luck >= 2),
  unspent_attribute_points integer NOT NULL DEFAULT 0
    CHECK (unspent_attribute_points BETWEEN 0 AND 76),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, ring_id),
  FOREIGN KEY (account_id, ring_id)
    REFERENCES alpha_starter_cooper(account_id, ring_id) ON DELETE RESTRICT
);

CREATE FUNCTION alpha_cooper_current_identity_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cooper current owner and Ring identity are immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER alpha_cooper_current_identity_immutable
  BEFORE UPDATE OF account_id, ring_id OR DELETE ON alpha_cooper_current_state
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_current_identity_immutable();

INSERT INTO alpha_cooper_current_state
  (account_id, ring_id, level, shine, comfort, charm, quality, luck)
SELECT account_id, ring_id, level, shine, comfort, charm, quality, luck
FROM alpha_starter_cooper;

CREATE FUNCTION alpha_cooper_initialize_current_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO alpha_cooper_current_state
    (account_id, ring_id, level, shine, comfort, charm, quality, luck)
  VALUES (NEW.account_id, NEW.ring_id, NEW.level, NEW.shine,
    NEW.comfort, NEW.charm, NEW.quality, NEW.luck);
  RETURN NEW;
END;
$$;

CREATE TRIGGER alpha_cooper_initialize_current_state
  AFTER INSERT ON alpha_starter_cooper
  FOR EACH ROW EXECUTE FUNCTION alpha_cooper_initialize_current_state();

COMMIT;
