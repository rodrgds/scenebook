CREATE INDEX IF NOT EXISTS artifact_uploads_finalized_provenance_idx
  ON artifact_uploads (
    workspace_id,
    project_id,
    lower(repository),
    commit_sha,
    manifest_hash,
    finalized_at DESC,
    id DESC
  )
  WHERE status = 'finalized';
