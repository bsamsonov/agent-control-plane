-- Row Level Security. The application role macp_app has no BYPASSRLS.
-- app.tenant_id is set with SET LOCAL inside every transaction by withTenant().
-- Fail-closed detail that bit us in testing: once set_config() has run on a connection,
-- current_setting(..., true) returns the EMPTY STRING (not NULL) in later transactions,
-- and ''::uuid raises instead of yielding no rows. NULLIF() restores the intended
-- semantics: unset context -> NULL predicate -> zero rows.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','tenant_credentials','policies','campaigns','workflow_runs',
    'step_results','approvals','audit_log','budget_state'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    $f$, t);
  END LOOP;
END $$;

-- tenants itself: a tenant may only see its own row.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON tenants;
CREATE POLICY tenant_self ON tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- audit_log is append-only for the app role: no UPDATE/DELETE grants.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'macp_app') THEN
    CREATE ROLE macp_app LOGIN PASSWORD 'macp_app';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO macp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO macp_app;
REVOKE UPDATE, DELETE ON audit_log FROM macp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO macp_app;
