ALTER TABLE repository_bindings
  ADD CONSTRAINT repository_bindings_scope_unique UNIQUE (workspace_id, project_id, id);

CREATE TABLE github_installation_bindings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  repository_binding_id text NOT NULL,
  installation_id text NOT NULL CHECK (installation_id ~ '^[1-9][0-9]{0,19}$'),
  github_repository_id text NOT NULL CHECK (github_repository_id ~ '^[1-9][0-9]{0,19}$'),
  default_branch text NOT NULL CHECK (length(default_branch) BETWEEN 1 AND 255),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, repository_binding_id)
    REFERENCES repository_bindings(workspace_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, project_id, id)
);
CREATE UNIQUE INDEX github_installation_bindings_active_repository_idx
  ON github_installation_bindings(workspace_id, project_id, repository_binding_id)
  WHERE revoked_at IS NULL;
CREATE INDEX github_installation_bindings_project_idx
  ON github_installation_bindings(workspace_id, project_id, created_at DESC);

CREATE TABLE github_source_changes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  installation_binding_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  source_path text NOT NULL CHECK (length(source_path) BETWEEN 1 AND 512),
  base_commit_sha text NOT NULL CHECK (base_commit_sha ~ '^[a-f0-9]{40}$'),
  base_blob_sha text NOT NULL CHECK (base_blob_sha ~ '^[a-f0-9]{40}$'),
  patch_hash text NOT NULL CHECK (patch_hash ~ '^[a-f0-9]{64}$'),
  branch_name text NOT NULL CHECK (branch_name ~ '^scenebook/[A-Za-z0-9._-]+$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  create_review_issue boolean NOT NULL,
  evidence_binding_json jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence_binding_json) = 'object'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_id text,
  lease_expires_at timestamptz,
  head_commit_sha text CHECK (head_commit_sha IS NULL OR head_commit_sha ~ '^[a-f0-9]{40}$'),
  head_blob_sha text CHECK (head_blob_sha IS NULL OR head_blob_sha ~ '^[a-f0-9]{40}$'),
  pull_request_number integer CHECK (pull_request_number IS NULL OR pull_request_number > 0),
  pull_request_url text,
  issue_number integer CHECK (issue_number IS NULL OR issue_number > 0),
  issue_url text,
  failure_code text,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, installation_binding_id)
    REFERENCES github_installation_bindings(workspace_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, idempotency_key),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK (
    status <> 'succeeded' OR
    (head_commit_sha IS NOT NULL AND head_blob_sha IS NOT NULL AND
     pull_request_number IS NOT NULL AND pull_request_url IS NOT NULL)
  )
);
CREATE INDEX github_source_changes_project_idx
  ON github_source_changes(workspace_id, project_id, created_at DESC);
