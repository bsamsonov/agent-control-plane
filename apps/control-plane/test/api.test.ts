/**
 * API tests — happy path over HTTP, cross-tenant approval returns 404.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startMcpServer } from '@macp/mcp-common';
import { migrate, seed, closePools } from '@macp/db';
import { setMcpServers, closeAllClients } from '../src/mcp-client.js';
import { app } from '../src/server.js';
import { recoverRuns } from '../src/workflow.js';
import { registerCrm, registerEsp, registerAnalytics, resetEspState } from './helpers.js';

describe('HTTP API', () => {
  let mcpServers: Array<{ close(): Promise<void> }> = [];

  beforeAll(async () => {
    await migrate();
    await seed();

    const crm = await startMcpServer({ name: 'crm-api', version: '0.0.0', port: 0, register: registerCrm, requireAuth: true });
    mcpServers.push(crm);

    const esp = await startMcpServer({ name: 'esp-api', version: '0.0.0', port: 0, register: registerEsp, requireAuth: true });
    mcpServers.push(esp);

    const analytics = await startMcpServer({ name: 'analytics-api', version: '0.0.0', port: 0, register: registerAnalytics, requireAuth: false });
    mcpServers.push(analytics);

    setMcpServers({ crm: crm.url, esp: esp.url, analytics: analytics.url, 'segment-py': 'http://127.0.0.1:31999' });
    await recoverRuns();
  });

  afterAll(async () => {
    await closeAllClients();
    for (const s of mcpServers) await s.close();
    await closePools();
  });

  function req(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
    return app.request(
      new Request(`http://localhost${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  }

  it('GET /healthz', async () => {
    const resp = await app.request('/healthz');
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
  });

  it('GET /api/me returns tenant info', async () => {
    const resp = await req('GET', '/api/me', { 'x-macp-user': 'marketer@acme.test' });
    expect(resp.status).toBe(200);
    const json: any = await resp.json();
    expect(json.actor).toBe('marketer@acme.test');
    expect(json.actorRole).toBe('marketer');
    expect(json.tenantId).toBeTruthy();
    expect(json.policy).toBeDefined();
    expect(json.budget).toBeDefined();
  });

  it('POST /api/campaigns + GET /api/runs/:id', async () => {
    resetEspState();
    const resp1 = await req('POST', '/api/campaigns', { 'x-macp-user': 'marketer@globex.test' }, { brief: 'Test campaign for API' });
    expect(resp1.status).toBe(201);
    const { campaignId, runId } = (await resp1.json()) as any;
    expect(campaignId).toBeTruthy();
    expect(runId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 2000));

    const resp2 = await req('GET', `/api/runs/${runId}`, { 'x-macp-user': 'marketer@globex.test' });
    expect(resp2.status).toBe(200);
    const json2: any = await resp2.json();
    expect(json2.run).toBeDefined();
    expect(json2.run.id).toBe(runId);
  });

  it('GET /api/runs/:id/stream sends step events and an approval event when the run suspends', async () => {
    resetEspState();
    const user = { 'x-macp-user': 'marketer@acme.test' };
    const created = await req('POST', '/api/campaigns', user, {
      brief: 'Reactivate customers inactive for 90 days, budget $500, channels email + ads.',
    });
    expect(created.status).toBe(201);
    const { runId } = (await created.json()) as { runId: string };

    const resp = await req('GET', `/api/runs/${runId}/stream`, user);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');

    // Read SSE frames until the approval event arrives (acme auto-approves sends only up to $100).
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    const events: any[] = [];
    let buf = '';
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !events.some((e) => e.event === 'approval')) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const f of frames) if (f.startsWith('data: ')) events.push(JSON.parse(f.slice(6)));
    }
    await reader.cancel();

    const steps = events.filter((e) => e.event === 'step').map((e) => e.data.stepId);
    expect(steps).toContain('create_campaign');
    const approval = events.find((e) => e.event === 'approval');
    expect(approval?.data).toMatchObject({
      stepId: 'send_email',
      status: 'awaiting_approval',
      policy: { effect: 'require_approval' },
    });
  });

  it('GET /api/approvals lists pending approvals', async () => {
    const resp = await req('GET', '/api/approvals?status=pending', { 'x-macp-user': 'marketer@acme.test' });
    expect(resp.status).toBe(200);
    const json: any = await resp.json();
    expect(Array.isArray(json.approvals)).toBe(true);
  });

  it('GET /api/audit returns audit log', async () => {
    const resp = await req('GET', '/api/audit?limit=10', { 'x-macp-user': 'marketer@acme.test' });
    expect(resp.status).toBe(200);
    const json: any = await resp.json();
    expect(Array.isArray(json.audit)).toBe(true);
  });

  it('cross-tenant: globex user cannot access acme approval', async () => {
    const acmeJson: any = await (await req('GET', '/api/approvals?status=pending', { 'x-macp-user': 'marketer@acme.test' })).json();
    const globexJson: any = await (await req('GET', '/api/approvals?status=pending', { 'x-macp-user': 'marketer@globex.test' })).json();
    const acmeIds = new Set((acmeJson.approvals as any[]).map((a: any) => a.id));

    // If acme has approvals, globex should not see them
    if (acmeIds.size > 0) {
      const overlap = (globexJson.approvals as any[]).some((a: any) => acmeIds.has(a.id));
      expect(overlap).toBe(false);
    }
  });

  it('cross-tenant approval decision returns 404', async () => {
    const acmeJson: any = await (await req('GET', '/api/approvals?status=pending', { 'x-macp-user': 'marketer@acme.test' })).json();
    const acmeApprovals = acmeJson.approvals as any[];
    if (acmeApprovals.length === 0) return;

    const approvalId = acmeApprovals[0]!.id;
    // Globex user tries to decide acme approval
    const resp = await req('POST', `/api/approvals/${approvalId}/decide`, { 'x-macp-user': 'marketer@globex.test' }, { decision: 'approved', note: 'test' });
    expect(resp.status).toBe(404);
  });

  it('missing auth returns 401', async () => {
    const resp = await req('GET', '/api/me', {});
    expect(resp.status).toBe(401);
  });
});
