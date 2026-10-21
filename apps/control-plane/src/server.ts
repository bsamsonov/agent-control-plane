/**
 * Control plane HTTP API — Hono server.
 *
 * Boot: resolves MCP server URLs, sets up routes, recovers interrupted runs.
 * Every handler resolves a TenantContext via dev auth and uses withTenant.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import type { TenantContext } from '@macp/db';
import { resolveAuth } from './auth.js';
import { setMcpServers, closeAllClients } from './mcp-client.js';
import { recoverRuns } from './workflow.js';

// Route handlers
import { postCampaigns } from './routes/campaigns.js';
import { getRunDetail, streamRun } from './routes/runs.js';
import { listApprovalsHandler, decideApprovalHandler } from './routes/approvals.js';
import { listAuditHandler } from './routes/audit.js';
import { getMe } from './routes/me.js';

export const app = new Hono<{ Variables: { tenantCtx: TenantContext } }>();

// ---- middleware: CORS for the web UI (runs before auth so preflights are not rejected) ----
app.use(
  '/api/*',
  cors({
    origin: (process.env.MACP_WEB_ORIGIN ?? 'http://localhost:3000').split(','),
    allowHeaders: ['Content-Type', 'X-MACP-User', 'Authorization'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
  }),
);

// ---- middleware: resolve tenant context ----
app.use('/api/*', async (c, next) => {
  try {
    const ctx = await resolveAuth({ headers: c.req.raw.headers });
    c.set('tenantCtx', ctx);
    await next();
  } catch (err: any) {
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: err.message } },
      err.status ?? 401,
    );
  }
});

// ---- helper: get ctx from middleware ----
function getCtx(c: any): any {
  return c.get('tenantCtx');
}

// ---- routes ----

app.get('/healthz', (c) => c.json({ ok: true }));

app.get('/api/me', (c) => getMe(c, getCtx(c)));
app.get('/api/audit', (c) => listAuditHandler(c, getCtx(c)));

app.post('/api/campaigns', (c) => postCampaigns(c, getCtx(c)));

app.get('/api/runs/:id', (c) => getRunDetail(c, getCtx(c)));
app.get('/api/runs/:id/stream', (c) => streamRun(c, getCtx(c)));

app.get('/api/approvals', (c) => listApprovalsHandler(c, getCtx(c)));
app.post('/api/approvals/:id/decide', (c) => decideApprovalHandler(c, getCtx(c)));

// ---- error handler ----
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json(
    { error: { code: 'INTERNAL', message: err.message } },
    (err as any).status ?? 500,
  );
});

// ---- start ----
export async function startServer(port: number, mcpUrls: Record<string, string>): Promise<{ close(): Promise<void> }> {
  setMcpServers(mcpUrls);
  await recoverRuns();

  const server = serve({ fetch: app.fetch, port });
  console.log(`control-plane listening on http://127.0.0.1:${port}`);

  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeAllClients();
    },
  };
}

// CLI entrypoint
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/server.ts');
if (isMain) {
  const port = parseInt(process.env.CONTROL_PLANE_PORT || '3001', 10);
  const mcpUrls = {
    crm: process.env.CRM_MCP_URL || 'http://127.0.0.1:3101',
    esp: process.env.ESP_MCP_URL || 'http://127.0.0.1:3102',
    analytics: process.env.ANALYTICS_MCP_URL || 'http://127.0.0.1:3103',
    'segment-py': process.env.SEGMENT_MCP_URL || 'http://127.0.0.1:3104',
  };
  startServer(port, mcpUrls).catch((err) => {
    console.error('Failed to start control plane:', err);
    process.exit(1);
  });
}
