BEGIN;

-- The finalized opening is durable issuance evidence for every canonical Box
-- source. The current bound wallet and Ring state are verified on-chain before
-- this insert; the original recipient/first-entry account is not eligibility.
CREATE OR REPLACE FUNCTION alpha_silver_progression_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM alpha_hybrid_operations h
    JOIN alpha_ert_reservations r ON r.operation_id = h.id
    JOIN alpha_hybrid_outbox o ON o.operation_id = h.id
    JOIN alpha_wallet_bindings w ON w.account_id = NEW.account_id
    JOIN alpha_silver_opening_finalizations f ON f.ring_mint_address = NEW.mint_address
    WHERE h.id = NEW.hybrid_operation_id AND h.account_id = NEW.account_id
      AND h.wallet_address = NEW.wallet_address AND h.cluster = NEW.cluster
      AND h.operation_type = 'silver_progression' AND h.status = 'pending'
      AND h.request_digest = NEW.request_digest AND h.ert_amount = NEW.ert_cost
      AND r.id = NEW.reservation_id AND r.account_id = NEW.account_id
      AND r.amount = NEW.ert_cost AND r.state = 'held'
      AND o.payload_digest = NEW.request_digest
      AND w.wallet_address = NEW.wallet_address
      AND f.cluster = NEW.cluster AND f.status = 'confirmed') THEN
    RAISE EXCEPTION 'Silver progression binding mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
