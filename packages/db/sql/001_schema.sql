-- MACP schema. Every tenant-scoped table carries tenant_id and is protected by RLS.
-- The application connects as a NON-superuser role (macp_app) that is NOT BYPASSRLS,
-- so a missing app.tenant_id yields zero rows rather than a full-table leak.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE NOT NULL,
  name        text NOT NULL,
  plan        text NOT NULL DEFAULT 'standard',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin','marketer','viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- Per-tenant credentials for upstream systems. enc_blob is envelope-encrypted
-- (AES-256-GCM with a DEK wrapped by MACP_MASTER_KEY). Never logged, never returned by API.
CREATE TABLE IF NOT EXISTS tenant_credentials (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  system      text NOT NULL CHECK (system IN ('crm','esp','analytics')),
  enc_blob    text NOT NULL,
  rotated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, system)
);

-- Declarative PDP rules. Shape is validated by @macp/policy (PolicyDocument).
CREATE TABLE IF NOT EXISTS policies (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  rule_json   jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brief       text NOT NULL,
  status      text NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','running','awaiting_approval','done','failed','cancelled')),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Durable workflow state. `snapshot` is the serialized suspend/resume state.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id   uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  workflow_name text NOT NULL DEFAULT 'run_campaign',
  status        text NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','suspended','done','failed','compensated')),
  snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,
  cursor_step   text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Idempotency ledger: a (run_id, step_id) pair executes its side effect at most once,
-- surviving process restarts. This is what makes resume safe.
CREATE TABLE IF NOT EXISTS step_results (
  run_id      uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id     text NOT NULL,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attempt     integer NOT NULL DEFAULT 1,
  status      text NOT NULL CHECK (status IN ('ok','failed','compensated')),
  output      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step_id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id       text NOT NULL,
  agent_id      text NOT NULL,
  tool          text NOT NULL,
  args_redacted jsonb NOT NULL,
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','expired')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES users(id),
  decision_note text,
  decided_at    timestamptz,
  UNIQUE (run_id, step_id)
);

-- Append-only. Every PDP decision lands here, including deny and require_approval.
CREATE TABLE IF NOT EXISTS audit_log (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id        uuid,
  step_id       text,
  actor         text NOT NULL,
  actor_role    text,
  agent_id      text,
  tool          text,
  args_redacted jsonb,
  decision      text NOT NULL,
  reason        text,
  rule_id       text,
  latency_ms    integer,
  tokens_in     integer,
  tokens_out    integer,
  cost_usd      numeric(12,6),
  ts            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_tenant_ts_idx ON audit_log (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS approvals_tenant_status_idx ON approvals (tenant_id, status);
CREATE INDEX IF NOT EXISTS workflow_runs_tenant_status_idx ON workflow_runs (tenant_id, status);

-- Per-tenant budget state consumed by the PDP (budget_state input).
CREATE TABLE IF NOT EXISTS budget_state (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  period        text NOT NULL DEFAULT 'month',
  limit_usd     numeric(12,2) NOT NULL DEFAULT 1000,
  spent_usd     numeric(12,2) NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
