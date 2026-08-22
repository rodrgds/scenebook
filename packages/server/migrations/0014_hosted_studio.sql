-- Hosted Studio working state is a mutable collaboration layer. Canonical
-- Scene revisions and evidence remain in their existing immutable tables.
CREATE TABLE IF NOT EXISTS studio_scene_documents (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  scene_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  saved_at bigint NOT NULL CHECK (saved_at >= 0),
  document_json jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, project_id, scene_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS studio_scene_documents_catalog_idx
  ON studio_scene_documents(workspace_id, project_id, saved_at DESC, scene_id DESC);

CREATE TABLE IF NOT EXISTS studio_scene_versions (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  scene_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  saved_at bigint NOT NULL CHECK (saved_at >= 0),
  document_json jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, project_id, scene_id, revision),
  FOREIGN KEY (workspace_id, project_id, scene_id)
    REFERENCES studio_scene_documents(workspace_id, project_id, scene_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS studio_scene_versions_history_idx
  ON studio_scene_versions(workspace_id, project_id, scene_id, revision DESC);

CREATE TABLE IF NOT EXISTS studio_project_documents (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  saved_at bigint NOT NULL CHECK (saved_at >= 0),
  document_json jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, project_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT
);
