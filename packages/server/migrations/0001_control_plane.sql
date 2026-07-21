CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  slug text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug),
  UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS repository_bindings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  repository text NOT NULL,
  workflow_ref_pattern text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (project_id, repository)
);

CREATE TABLE IF NOT EXISTS scene_revisions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  scene_id text NOT NULL,
  revision_hash text NOT NULL CHECK (revision_hash ~ '^[a-f0-9]{64}$'),
  source_json jsonb NOT NULL,
  privacy_json jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (project_id, scene_id, revision_hash)
);
CREATE INDEX IF NOT EXISTS scene_revisions_lookup_idx ON scene_revisions(project_id, scene_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reviews (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  review_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'approved', 'changes-requested', 'rejected', 'closed')),
  change_state text NOT NULL CHECK (change_state IN ('unchanged', 'changed', 'broken', 'blocked', 'unverified')),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS review_comments (
  id text PRIMARY KEY,
  review_id text NOT NULL REFERENCES reviews(id) ON DELETE RESTRICT,
  actor_id text NOT NULL,
  body text NOT NULL,
  step_id text,
  state_id text,
  region_json jsonb,
  resolved_at timestamptz,
  resolved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
);

CREATE TABLE IF NOT EXISTS review_decisions (
  id text PRIMARY KEY,
  review_id text NOT NULL REFERENCES reviews(id) ON DELETE RESTRICT,
  change_id text,
  actor_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve', 'reject', 'dismiss', 'request-change')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS artifact_uploads (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  repository text NOT NULL,
  commit_sha text NOT NULL,
  git_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'staged', 'finalized', 'expired')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  manifest_hash text CHECK (manifest_hash IS NULL OR manifest_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  finalized_at timestamptz,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'finalized' AND manifest_hash IS NOT NULL AND finalized_at IS NOT NULL) OR
    (status <> 'finalized' AND manifest_hash IS NULL AND finalized_at IS NULL)
  ),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS artifact_objects (
  upload_id text NOT NULL REFERENCES artifact_uploads(id) ON DELETE RESTRICT,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  media_type text NOT NULL CHECK (
    media_type IN (
      'application/json',
      'application/pdf',
      'application/zip',
      'image/avif',
      'image/gif',
      'image/jpeg',
      'image/png',
      'image/webp',
      'text/markdown',
      'text/plain',
      'video/mp4',
      'video/webm'
    )
  ),
  status text NOT NULL CHECK (status IN ('pending', 'staged', 'finalized')),
  staging_key text,
  final_key text,
  PRIMARY KEY (upload_id, sha256),
  CHECK (
    (status = 'pending' AND staging_key IS NULL AND final_key IS NULL) OR
    (status = 'staged' AND staging_key IS NOT NULL AND final_key IS NULL) OR
    (status = 'finalized' AND staging_key IS NOT NULL AND final_key IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS channels (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('public-catalog', 'private-portal', 'docs-sync', 'embed', 'static', 'offline')),
  policy_json jsonb NOT NULL,
  webhook_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(webhook_ids) = 'array'),
  analytics_token_hash text NOT NULL,
  current_release_id text,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (project_id, slug)
);

CREATE TABLE IF NOT EXISTS releases (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  sequence bigint NOT NULL CHECK (sequence > 0),
  status text NOT NULL CHECK (status IN ('staged', 'published', 'superseded', 'rolled-back')),
  release_json jsonb NOT NULL,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  published_at timestamptz NOT NULL,
  supersedes_release_id text REFERENCES releases(id) ON DELETE RESTRICT,
  rollback_of_release_id text REFERENCES releases(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (channel_id, sequence),
  UNIQUE (channel_id, idempotency_key)
);
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_current_release_fk;
ALTER TABLE channels ADD CONSTRAINT channels_current_release_fk FOREIGN KEY (current_release_id) REFERENCES releases(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS analytics_events (
  id text PRIMARY KEY,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  release_id text NOT NULL REFERENCES releases(id) ON DELETE RESTRICT,
  scene_id text NOT NULL,
  step_id text,
  event_type text NOT NULL CHECK (event_type IN ('view', 'start', 'step', 'complete', 'cta', 'error')),
  occurred_at timestamptz NOT NULL,
  anonymous_id_hash text,
  session_id_hash text,
  properties_json jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS analytics_release_idx ON analytics_events(release_id, occurred_at);

CREATE TABLE IF NOT EXISTS cta_submissions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  release_id text NOT NULL REFERENCES releases(id) ON DELETE RESTRICT,
  scene_id text NOT NULL,
  step_id text,
  webhook_id text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  encrypted_payload text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id text PRIMARY KEY,
  submission_id text NOT NULL REFERENCES cta_submissions(id) ON DELETE RESTRICT,
  webhook_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'delivering', 'succeeded', 'failed', 'exhausted')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status integer,
  last_error text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_pending_idx ON webhook_deliveries(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS audit_events (
  sequence bigserial PRIMARY KEY,
  id text NOT NULL UNIQUE,
  workspace_id text REFERENCES workspaces(id) ON DELETE RESTRICT,
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  request_id text NOT NULL,
  ip_hash text,
  metadata_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_workspace_idx ON audit_events(workspace_id, sequence);

CREATE TABLE IF NOT EXISTS oidc_token_uses (
  token_id text PRIMARY KEY,
  repository text NOT NULL,
  commit_sha text NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS oidc_token_uses_expiry_idx ON oidc_token_uses(expires_at);

CREATE OR REPLACE FUNCTION scenebook_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION scenebook_reject_mutation();
DROP TRIGGER IF EXISTS scene_revisions_append_only ON scene_revisions;
CREATE TRIGGER scene_revisions_append_only BEFORE UPDATE OR DELETE ON scene_revisions FOR EACH ROW EXECUTE FUNCTION scenebook_reject_mutation();
DROP TRIGGER IF EXISTS review_comments_append_only ON review_comments;
CREATE TRIGGER review_comments_append_only BEFORE UPDATE OR DELETE ON review_comments FOR EACH ROW EXECUTE FUNCTION scenebook_reject_mutation();
DROP TRIGGER IF EXISTS review_decisions_append_only ON review_decisions;
CREATE TRIGGER review_decisions_append_only BEFORE UPDATE OR DELETE ON review_decisions FOR EACH ROW EXECUTE FUNCTION scenebook_reject_mutation();
DROP TRIGGER IF EXISTS analytics_events_append_only ON analytics_events;
CREATE TRIGGER analytics_events_append_only BEFORE UPDATE OR DELETE ON analytics_events FOR EACH ROW EXECUTE FUNCTION scenebook_reject_mutation();

CREATE OR REPLACE FUNCTION scenebook_protect_release_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.release_json IS DISTINCT FROM OLD.release_json OR NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash THEN
    RAISE EXCEPTION 'release content is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS release_content_immutable ON releases;
CREATE TRIGGER release_content_immutable BEFORE UPDATE ON releases FOR EACH ROW EXECUTE FUNCTION scenebook_protect_release_content();
