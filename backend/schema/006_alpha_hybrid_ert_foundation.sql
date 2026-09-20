BEGIN;

CREATE TABLE alpha_ert_accounts (
  account_id uuid PRIMARY KEY REFERENCES alpha_accounts(id) ON DELETE CASCADE
);

CREATE TABLE alpha_ert_ledger (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES alpha_ert_accounts(account_id),
  event_key text NOT NULL UNIQUE,
  amount numeric(48,18) NOT NULL CHECK (amount <> 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alpha_ert_ledger_account_idx ON alpha_ert_ledger(account_id);

CREATE TABLE alpha_hybrid_operations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES alpha_ert_accounts(account_id),
  wallet_address text NOT NULL,
  cluster text NOT NULL CHECK (cluster IN ('local-validator', 'devnet')),
  operation_type text NOT NULL CHECK (operation_type IN
    ('cooper_breeding', 'silver_progression', 'cooper_level_up', 'draw')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  ert_amount numeric(48,18) NOT NULL CHECK (ert_amount > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending', 'unknown', 'confirmed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE alpha_hybrid_operations ADD CONSTRAINT alpha_hybrid_operation_account_key
  UNIQUE (id, account_id);
CREATE INDEX alpha_hybrid_operations_account_idx
  ON alpha_hybrid_operations(account_id, created_at);

CREATE TABLE alpha_ert_reservations (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES alpha_ert_accounts(account_id),
  amount numeric(48,18) NOT NULL CHECK (amount > 0),
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'consumed', 'released')),
  release_evidence_digest text CHECK
    (release_evidence_digest IS NULL OR release_evidence_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alpha_ert_release_requires_evidence CHECK
    (state <> 'released' OR release_evidence_digest IS NOT NULL),
  FOREIGN KEY (operation_id, account_id)
    REFERENCES alpha_hybrid_operations(id, account_id)
);
CREATE INDEX alpha_ert_reservations_held_idx
  ON alpha_ert_reservations(account_id) WHERE state = 'held';

CREATE TABLE alpha_hybrid_outbox (
  operation_id uuid PRIMARY KEY REFERENCES alpha_hybrid_operations(id),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'unknown', 'done')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alpha_hybrid_inbox (
  source text NOT NULL,
  event_key text NOT NULL,
  operation_id uuid NOT NULL REFERENCES alpha_hybrid_operations(id),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'unverified' CHECK (state IN ('unverified', 'verified')),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, event_key)
);
CREATE INDEX alpha_hybrid_inbox_operation_idx ON alpha_hybrid_inbox(operation_id);

CREATE VIEW alpha_ert_available AS
SELECT a.account_id,
  COALESCE(l.balance, 0::numeric) AS balance,
  COALESCE(r.held, 0::numeric) AS reserved,
  COALESCE(l.balance, 0::numeric) - COALESCE(r.held, 0::numeric) AS available
FROM alpha_ert_accounts a
LEFT JOIN LATERAL (
  SELECT SUM(amount) AS balance FROM alpha_ert_ledger WHERE account_id = a.account_id
) l ON true
LEFT JOIN LATERAL (
  SELECT SUM(amount) AS held FROM alpha_ert_reservations
  WHERE account_id = a.account_id AND state = 'held'
) r ON true;

CREATE FUNCTION alpha_ert_validate_reservation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE spendable numeric;
BEGIN
  IF NEW.state <> 'held' OR NEW.release_evidence_digest IS NOT NULL THEN
    RAISE EXCEPTION 'ERT reservation must start held' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM alpha_ert_accounts WHERE account_id = NEW.account_id FOR UPDATE;
  SELECT available INTO spendable FROM alpha_ert_available WHERE account_id = NEW.account_id;
  IF spendable IS NULL OR spendable < NEW.amount THEN
    RAISE EXCEPTION 'ERT reservation exceeds available balance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_ert_validate_reservation
  BEFORE INSERT ON alpha_ert_reservations
  FOR EACH ROW EXECUTE FUNCTION alpha_ert_validate_reservation();

CREATE FUNCTION alpha_ert_reservation_hold_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ERT reservation requires verified settlement or release policy'
    USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER alpha_ert_reservation_hold_immutable
  BEFORE UPDATE OR DELETE ON alpha_ert_reservations
  FOR EACH ROW EXECUTE FUNCTION alpha_ert_reservation_hold_immutable();

CREATE FUNCTION alpha_ert_reject_reserved_spend() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE spendable numeric;
BEGIN
  IF NEW.amount < 0 THEN
    PERFORM 1 FROM alpha_ert_accounts WHERE account_id = NEW.account_id FOR UPDATE;
    SELECT available INTO spendable FROM alpha_ert_available WHERE account_id = NEW.account_id;
    IF spendable IS NULL OR spendable + NEW.amount < 0 THEN
      RAISE EXCEPTION 'ERT spend exceeds available balance' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER alpha_ert_reject_reserved_spend
  BEFORE INSERT ON alpha_ert_ledger
  FOR EACH ROW EXECUTE FUNCTION alpha_ert_reject_reserved_spend();

CREATE FUNCTION alpha_ert_ledger_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ERT ledger is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER alpha_ert_ledger_immutable
  BEFORE UPDATE OR DELETE ON alpha_ert_ledger
  FOR EACH ROW EXECUTE FUNCTION alpha_ert_ledger_immutable();

CREATE FUNCTION alpha_hybrid_binding_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.account_id, NEW.wallet_address, NEW.cluster,
      NEW.operation_type, NEW.request_digest, NEW.ert_amount, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.account_id, OLD.wallet_address, OLD.cluster,
      OLD.operation_type, OLD.request_digest, OLD.ert_amount, OLD.created_at) THEN
    RAISE EXCEPTION 'Hybrid operation binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alpha_hybrid_binding_immutable
  BEFORE UPDATE ON alpha_hybrid_operations
  FOR EACH ROW EXECUTE FUNCTION alpha_hybrid_binding_immutable();

COMMIT;
