ALTER TABLE artifact_uploads
  ADD COLUMN IF NOT EXISTS gc_claim_id text,
  ADD COLUMN IF NOT EXISTS gc_claimed_until timestamptz,
  ADD COLUMN IF NOT EXISTS gc_completed_at timestamptz;

ALTER TABLE artifact_uploads
  DROP CONSTRAINT IF EXISTS artifact_uploads_gc_claim_consistency;

ALTER TABLE artifact_uploads
  ADD CONSTRAINT artifact_uploads_gc_claim_consistency CHECK (
    (gc_claim_id IS NULL AND gc_claimed_until IS NULL) OR
    (gc_claim_id IS NOT NULL AND gc_claimed_until IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS artifact_uploads_active_quota_idx
  ON artifact_uploads(workspace_id, expires_at)
  WHERE status IN ('pending', 'staged');

CREATE INDEX IF NOT EXISTS artifact_uploads_gc_claim_idx
  ON artifact_uploads(expires_at, gc_claimed_until)
  WHERE status <> 'finalized' AND gc_completed_at IS NULL;
