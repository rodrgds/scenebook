CREATE TABLE IF NOT EXISTS verification_runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  scene_id text NOT NULL,
  source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{64}$'),
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  artifact_json jsonb NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, scene_id, source_revision) REFERENCES scene_revisions(project_id, scene_id, revision_hash) ON DELETE RESTRICT,
  UNIQUE (id, artifact_hash),
  UNIQUE (project_id, artifact_hash),
  UNIQUE (workspace_id, project_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS verification_builds (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  artifact_json jsonb NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (project_id, artifact_hash),
  UNIQUE (workspace_id, project_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS verification_baselines (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  scene_id text NOT NULL,
  source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{64}$'),
  source_run_id text NOT NULL REFERENCES verification_runs(id) ON DELETE RESTRICT,
  source_run_hash text NOT NULL CHECK (source_run_hash ~ '^[a-f0-9]{64}$'),
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  artifact_json jsonb NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, scene_id, source_revision) REFERENCES scene_revisions(project_id, scene_id, revision_hash) ON DELETE RESTRICT,
  FOREIGN KEY (source_run_id, source_run_hash) REFERENCES verification_runs(id, artifact_hash) ON DELETE RESTRICT,
  UNIQUE (project_id, artifact_hash),
  UNIQUE (workspace_id, project_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS review_approvals (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('baseline', 'release-candidate')),
  subject_id text NOT NULL,
  subject_revision text NOT NULL CHECK (subject_revision ~ '^[a-f0-9]{64}$'),
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  approval_json jsonb NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (project_id, artifact_hash),
  UNIQUE (workspace_id, project_id, idempotency_key)
);

ALTER TABLE releases ADD COLUMN IF NOT EXISTS evidence_json jsonb;

DROP TRIGGER IF EXISTS verification_runs_append_only ON verification_runs;
CREATE TRIGGER verification_runs_append_only BEFORE UPDATE OR DELETE ON verification_runs FOR EACH ROW EXECUTE FUNCTION scenebook_reject_mutation();
DROP TRIGGER IF EXISTS verification_builds_append_only ON verification_builds;
CREATE TRIGGER verification_builds_append_only BEFORE UPDATE OR DELETE ON verification_builds FOR EACH ROW EXECUTE FUNCTION scenebook_reject_mutation();
DROP TRIGGER IF EXISTS verification_baselines_append_only ON verification_baselines;
CREATE TRIGGER verification_baselines_append_only BEFORE UPDATE OR DELETE ON verification_baselines FOR EACH ROW EXECUTE FUNCTION scenebook_reject_mutation();
DROP TRIGGER IF EXISTS review_approvals_append_only ON review_approvals;
CREATE TRIGGER review_approvals_append_only BEFORE UPDATE OR DELETE ON review_approvals FOR EACH ROW EXECUTE FUNCTION scenebook_reject_mutation();

CREATE OR REPLACE FUNCTION scenebook_protect_release_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.evidence_json IS DISTINCT FROM OLD.evidence_json THEN
    RAISE EXCEPTION 'release promotion evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS release_evidence_immutable ON releases;
CREATE TRIGGER release_evidence_immutable BEFORE UPDATE ON releases FOR EACH ROW EXECUTE FUNCTION scenebook_protect_release_evidence();
