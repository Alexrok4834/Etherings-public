-- Preserve historical one-point submissions while recording new full allocation vectors.
ALTER TABLE alpha_silver_allocation_submissions
  ALTER COLUMN attribute DROP NOT NULL,
  ADD COLUMN allocation jsonb,
  ADD CONSTRAINT alpha_silver_allocation_shape CHECK (
    (attribute IS NOT NULL AND allocation IS NULL) OR
    (attribute IS NULL AND allocation IS NOT NULL AND
     jsonb_typeof(allocation) = 'object' AND
     allocation ?& ARRAY['comfort','charm','quality','luck']));
