CREATE TABLE IF NOT EXISTS publication_login_handoffs (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
  source_session_id text NOT NULL REFERENCES user_sessions(id) ON DELETE RESTRICT,
  grant_id text NOT NULL REFERENCES portal_grants(id) ON DELETE RESTRICT,
  audience_origin text NOT NULL CHECK (
    length(audience_origin) BETWEEN 8 AND 2048 AND audience_origin !~ '[/?#]$'
  ),
  return_path text NOT NULL CHECK (
    length(return_path) BETWEEN 7 AND 2048 AND return_path LIKE '/s/%' AND return_path NOT LIKE '%//%'
  ),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, channel_id)
    REFERENCES channels(workspace_id, project_id, id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX IF NOT EXISTS publication_login_handoffs_expiry_idx
  ON publication_login_handoffs(expires_at) WHERE consumed_at IS NULL;
