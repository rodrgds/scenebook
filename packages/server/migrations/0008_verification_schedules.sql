ALTER TABLE identity_api_tokens DROP CONSTRAINT IF EXISTS identity_api_tokens_scopes_check;
ALTER TABLE identity_api_tokens ADD CONSTRAINT identity_api_tokens_scopes_check CHECK (
  cardinality(scopes) > 0 AND scopes <@ ARRAY[
    'workspace:read','workspace:admin','project:read','project:write','review:read',
    'review:write','channel:read','channel:write','release:write','schedule:read',
    'schedule:write','runner:admin','analytics:read','audit:read'
  ]::text[]
);

ALTER TABLE user_sessions DROP CONSTRAINT IF EXISTS user_sessions_scopes_check;
ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_scopes_check CHECK (
  cardinality(scopes) > 0 AND scopes <@ ARRAY[
    'workspace:read','workspace:admin','project:read','project:write','review:read',
    'review:write','channel:read','channel:write','release:write','schedule:read',
    'schedule:write','runner:admin','analytics:read','audit:read'
  ]::text[]
);

ALTER TABLE repository_bindings
  ADD CONSTRAINT repository_bindings_workspace_project_id_unique
  UNIQUE (workspace_id, project_id, id);

CREATE TABLE verification_schedules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  repository_binding_id text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  source_ref text NOT NULL CHECK (
    source_ref ~ '^refs/(heads|tags)/[!-~]+$' AND
    source_ref !~ '\.\.' AND source_ref !~ '@\{' AND position(chr(92) in source_ref) = 0 AND
    source_ref !~ '//' AND source_ref !~ '/$' AND source_ref !~ '\.$' AND
    source_ref !~ '\.lock$'
  ),
  environment_id text NOT NULL,
  run_target_ids jsonb NOT NULL CHECK (
    jsonb_typeof(run_target_ids) = 'array' AND jsonb_array_length(run_target_ids) BETWEEN 1 AND 1000
  ),
  interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 300 AND 31536000),
  freshness_target_seconds integer NOT NULL CHECK (
    freshness_target_seconds BETWEEN interval_seconds AND 31536000
  ),
  max_runtime_seconds integer NOT NULL CHECK (max_runtime_seconds BETWEEN 60 AND 86400),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  status text NOT NULL CHECK (status IN ('active', 'paused')),
  next_due_at timestamptz NOT NULL,
  last_enqueued_at timestamptz,
  last_completed_at timestamptz,
  last_successful_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, repository_binding_id)
    REFERENCES repository_bindings(workspace_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, project_id, id)
);
CREATE INDEX verification_schedules_due_idx
  ON verification_schedules(next_due_at, id) WHERE status = 'active';

CREATE TABLE verification_runners (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  UNIQUE (workspace_id, project_id, id)
);
CREATE INDEX verification_runners_active_idx
  ON verification_runners(project_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE verification_runner_schedules (
  runner_id text NOT NULL REFERENCES verification_runners(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  schedule_id text NOT NULL,
  PRIMARY KEY (runner_id, schedule_id),
  FOREIGN KEY (workspace_id, project_id, runner_id)
    REFERENCES verification_runners(workspace_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, schedule_id)
    REFERENCES verification_schedules(workspace_id, project_id, id) ON DELETE RESTRICT
);

CREATE TABLE verification_jobs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  schedule_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('schedule', 'manual')),
  state text NOT NULL CHECK (state IN ('queued', 'leased', 'succeeded', 'failed', 'cancelled')),
  idempotency_key text NOT NULL,
  execution_json jsonb NOT NULL CHECK (jsonb_typeof(execution_json) = 'object'),
  due_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  lease_id text,
  leased_by_runner_id text,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  deadline_at timestamptz,
  result_json jsonb,
  result_hash text CHECK (result_hash IS NULL OR result_hash ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, schedule_id)
    REFERENCES verification_schedules(workspace_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, leased_by_runner_id)
    REFERENCES verification_runners(workspace_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (schedule_id, idempotency_key),
  CHECK ((result_json IS NULL) = (result_hash IS NULL)),
  CHECK ((state IN ('succeeded','failed','cancelled')) = (completed_at IS NOT NULL)),
  CHECK (state NOT IN ('succeeded','failed') OR result_json IS NOT NULL),
  CHECK (
    (state = 'leased' AND lease_id IS NOT NULL AND leased_by_runner_id IS NOT NULL AND
      leased_at IS NOT NULL AND lease_expires_at IS NOT NULL AND deadline_at IS NOT NULL) OR
    state <> 'leased'
  )
);
CREATE INDEX verification_jobs_claim_idx
  ON verification_jobs(available_at, due_at, id) WHERE state = 'queued';
CREATE INDEX verification_jobs_expired_lease_idx
  ON verification_jobs(lease_expires_at, id) WHERE state = 'leased';
CREATE INDEX verification_jobs_schedule_idx
  ON verification_jobs(schedule_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION scenebook_protect_verification_job() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('succeeded','failed','cancelled') THEN
    RAISE EXCEPTION 'terminal verification jobs are immutable';
  END IF;
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.project_id <> OLD.project_id OR
     NEW.schedule_id <> OLD.schedule_id OR NEW.reason <> OLD.reason OR
     NEW.idempotency_key <> OLD.idempotency_key OR NEW.execution_json <> OLD.execution_json OR
     NEW.due_at <> OLD.due_at OR NEW.max_attempts <> OLD.max_attempts OR
     NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'verification job identity and execution contract are immutable';
  END IF;
  IF NOT (
    (OLD.state = 'queued' AND NEW.state IN ('queued','leased','failed','cancelled')) OR
    (OLD.state = 'leased' AND NEW.state IN ('queued','leased','succeeded','failed','cancelled'))
  ) THEN
    RAISE EXCEPTION 'invalid verification job state transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER verification_jobs_state_guard BEFORE UPDATE ON verification_jobs
  FOR EACH ROW EXECUTE FUNCTION scenebook_protect_verification_job();

CREATE OR REPLACE FUNCTION scenebook_reject_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'control-plane coordination records cannot be deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER verification_schedules_no_delete BEFORE DELETE ON verification_schedules
  FOR EACH ROW EXECUTE FUNCTION scenebook_reject_delete();
CREATE TRIGGER verification_runners_no_delete BEFORE DELETE ON verification_runners
  FOR EACH ROW EXECUTE FUNCTION scenebook_reject_delete();
CREATE TRIGGER verification_jobs_no_delete BEFORE DELETE ON verification_jobs
  FOR EACH ROW EXECUTE FUNCTION scenebook_reject_delete();
