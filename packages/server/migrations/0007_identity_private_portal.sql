CREATE TABLE IF NOT EXISTS identity_users (
  id text PRIMARY KEY,
  email text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL,
  disabled_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS identity_users_email_idx ON identity_users(lower(email));

CREATE TABLE IF NOT EXISTS workspace_memberships (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'reviewer', 'viewer')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_memberships_active_user_idx
  ON workspace_memberships(user_id, workspace_id) WHERE revoked_at IS NULL;

ALTER TABLE channels
  ADD CONSTRAINT channels_workspace_project_id_unique UNIQUE (workspace_id, project_id, id);

CREATE TABLE IF NOT EXISTS identity_api_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name text NOT NULL,
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) > 0 AND scopes <@ ARRAY[
      'workspace:read','workspace:admin','project:read','project:write','review:read',
      'review:write','channel:read','channel:write','release:write','analytics:read','audit:read'
    ]::text[]
  ),
  project_id text,
  channel_id text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, channel_id)
    REFERENCES channels(workspace_id, project_id, id) ON DELETE RESTRICT,
  CHECK (channel_id IS NULL OR project_id IS NOT NULL),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS identity_api_tokens_active_user_idx
  ON identity_api_tokens(user_id, workspace_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS user_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
  source_token_id text NOT NULL REFERENCES identity_api_tokens(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) > 0 AND scopes <@ ARRAY[
      'workspace:read','workspace:admin','project:read','project:write','review:read',
      'review:write','channel:read','channel:write','release:write','analytics:read','audit:read'
    ]::text[]
  ),
  project_id text,
  channel_id text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, channel_id)
    REFERENCES channels(workspace_id, project_id, id) ON DELETE RESTRICT,
  CHECK (channel_id IS NULL OR project_id IS NOT NULL),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS user_sessions_active_user_idx
  ON user_sessions(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS portal_grants (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  channel_id text NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('user', 'link')),
  subject_user_id text REFERENCES identity_users(id) ON DELETE RESTRICT,
  subject_label text,
  permission text NOT NULL CHECK (permission IN ('view', 'review')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, channel_id)
    REFERENCES channels(workspace_id, project_id, id) ON DELETE RESTRICT,
  CHECK (
    (subject_kind = 'user' AND subject_user_id IS NOT NULL AND subject_label IS NULL) OR
    (subject_kind = 'link' AND subject_user_id IS NULL AND subject_label IS NOT NULL)
  ),
  CHECK (subject_kind = 'user' OR permission = 'view'),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS portal_grants_active_user_idx
  ON portal_grants(workspace_id, project_id, channel_id, subject_user_id, expires_at)
  WHERE revoked_at IS NULL AND subject_kind = 'user';

CREATE TABLE IF NOT EXISTS private_share_links (
  id text PRIMARY KEY,
  grant_id text NOT NULL REFERENCES portal_grants(id) ON DELETE RESTRICT,
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS private_share_links_active_grant_idx
  ON private_share_links(grant_id, expires_at) WHERE revoked_at IS NULL;
