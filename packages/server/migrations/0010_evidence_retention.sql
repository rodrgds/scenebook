CREATE TABLE IF NOT EXISTS evidence_object_lifecycle (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  media_type text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  retention_class text NOT NULL CHECK (retention_class IN ('standard', 'diagnostic')),
  status text NOT NULL CHECK (status IN ('active', 'claimed', 'deleting', 'deleted')),
  first_finalized_at timestamptz NOT NULL,
  last_finalized_at timestamptz NOT NULL,
  claim_id text,
  claimed_until timestamptz,
  deleted_at timestamptz,
  last_evaluated_at timestamptz,
  PRIMARY KEY (workspace_id, sha256, media_type),
  CHECK (last_finalized_at >= first_finalized_at),
  CHECK (
    (status = 'active' AND claim_id IS NULL AND claimed_until IS NULL AND deleted_at IS NULL) OR
    (status IN ('claimed', 'deleting') AND claim_id IS NOT NULL AND claimed_until IS NOT NULL AND deleted_at IS NULL) OR
    (status = 'deleted' AND claim_id IS NULL AND claimed_until IS NULL AND deleted_at IS NOT NULL)
  )
);

-- Backfill existing finalized identities. Video evidence is short-lived unless
-- another immutable evidence/Release reference protects it; trace ZIP roles
-- are refined when Runs are recorded by current servers.
INSERT INTO evidence_object_lifecycle(
  workspace_id,sha256,media_type,byte_length,retention_class,status,
  first_finalized_at,last_finalized_at
)
SELECT
  u.workspace_id,
  o.sha256,
  o.media_type,
  MAX(o.byte_length),
  CASE WHEN o.media_type IN ('video/mp4','video/webm') THEN 'diagnostic' ELSE 'standard' END,
  'active',
  MIN(u.finalized_at),
  MAX(u.finalized_at)
FROM artifact_objects o
JOIN artifact_uploads u ON u.id=o.upload_id
WHERE u.status='finalized' AND o.status='finalized' AND u.finalized_at IS NOT NULL
GROUP BY u.workspace_id,o.sha256,o.media_type
ON CONFLICT (workspace_id,sha256,media_type) DO NOTHING;

CREATE INDEX IF NOT EXISTS evidence_object_retention_candidates_idx
  ON evidence_object_lifecycle(
    status,last_evaluated_at,retention_class,last_finalized_at,workspace_id,sha256,media_type
  );

CREATE TABLE IF NOT EXISTS evidence_retention_events (
  sequence bigserial PRIMARY KEY,
  id text NOT NULL UNIQUE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  media_type text NOT NULL,
  claim_id text,
  disposition text NOT NULL CHECK (disposition IN (
    'eligible','dry-run-eligible','protected','grace-period','deleting','deleted','delete-failed','claim-lost'
  )),
  reason text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_retention_events_workspace_idx
  ON evidence_retention_events(workspace_id,sequence);

DROP TRIGGER IF EXISTS evidence_retention_events_append_only ON evidence_retention_events;
CREATE TRIGGER evidence_retention_events_append_only
  BEFORE UPDATE OR DELETE ON evidence_retention_events
  FOR EACH ROW EXECUTE FUNCTION scenebook_reject_mutation();
