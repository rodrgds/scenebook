CREATE TABLE IF NOT EXISTS custom_domains (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  channel_id text NOT NULL,
  hostname text NOT NULL,
  routing_target text NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'pending-dns',
      'ready-to-provision',
      'provisioning',
      'active',
      'disabling',
      'disabled',
      'removing',
      'removed',
      'failed'
    )
  ),
  dns_status text NOT NULL CHECK (dns_status IN ('pending', 'verified', 'failed')),
  challenge_name text NOT NULL,
  challenge_value text NOT NULL,
  dns_checked_at timestamptz,
  dns_verified_at timestamptz,
  provisioning_json jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, channel_id)
    REFERENCES channels(workspace_id, project_id, id) ON DELETE RESTRICT,
  CHECK (hostname = lower(hostname) AND hostname !~ '[.]$'),
  CHECK (routing_target = lower(routing_target) AND routing_target !~ '[.]$'),
  CHECK (
    (dns_status = 'verified' AND dns_verified_at IS NOT NULL) OR
    (dns_status <> 'verified' AND dns_verified_at IS NULL)
  ),
  CHECK (
    (status = 'removed' AND removed_at IS NOT NULL) OR
    (status <> 'removed' AND removed_at IS NULL)
  ),
  CHECK (provisioning_json IS NULL OR jsonb_typeof(provisioning_json) = 'object'),
  CHECK (
    status NOT IN ('provisioning', 'active', 'disabling', 'disabled', 'removing', 'failed') OR
    provisioning_json IS NOT NULL
  ),
  CHECK (
    status NOT IN ('provisioning', 'active') OR
    provisioning_json->>'desiredState' = 'active'
  ),
  CHECK (
    status NOT IN ('disabling', 'disabled') OR
    provisioning_json->>'desiredState' = 'disabled'
  ),
  CHECK (
    status <> 'removing' OR provisioning_json->>'desiredState' = 'removed'
  ),
  CHECK (
    status <> 'removed' OR
    provisioning_json IS NULL OR
    provisioning_json->>'desiredState' = 'removed'
  )
);

-- An unverified claim cannot squat another tenant's hostname. Once DNS is
-- verified, a hostname can belong to only one nonremoved lifecycle globally.
-- Removed records remain as history and can be reclaimed with a fresh proof.
CREATE UNIQUE INDEX IF NOT EXISTS custom_domains_live_hostname_unique
  ON custom_domains(lower(hostname)) WHERE status NOT IN ('pending-dns', 'removed');

-- A Channel has exactly one live canonical custom origin. Operators must fully
-- remove the old ingress and certificate before assigning a replacement.
CREATE UNIQUE INDEX IF NOT EXISTS custom_domains_live_channel_unique
  ON custom_domains(workspace_id, project_id, channel_id) WHERE status <> 'removed';

CREATE INDEX IF NOT EXISTS custom_domains_project_idx
  ON custom_domains(workspace_id, project_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS custom_domains_reconcile_idx
  ON custom_domains(status, updated_at)
  WHERE status IN ('provisioning', 'disabling', 'removing', 'failed');
