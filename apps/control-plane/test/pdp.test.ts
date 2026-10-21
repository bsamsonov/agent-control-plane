/**
 * PDP tests: allow/deny/require_approval produce audit rows with redaction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startMcpServer } from '@macp/mcp-common';
import {
  withTenant,
  listAudit,
  listApprovals,
  migrate,
  seed,
  closePools,
  createCampaign,
  createRun,
} from '@macp/db';
import type { TenantContext } from '@macp/db';
import { setMcpServers, closeAllClients } from '../src/mcp-client.js';
import { guardedCall } from '../src/pdp.js';
import { registerCrm, registerEsp, registerAnalytics, resetEspState } from './helpers.js';

const acmeCtx: TenantContext = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  actor: 'marketer@acme.test',
  actorRole: 'marketer',
};

const globexCtx: TenantContext = {
  tenantId: '22222222-2222-2222-2222-222222222222',
  actor: 'marketer@globex.test',
  actorRole: 'marketer',
};

describe('PDP guardedCall', () => {
  let crmUrl: string;
  let espUrl: string;
  let analyticsUrl: string;
  let servers: Array<{ close(): Promise<void> }> = [];
  // Approvals carry a FK to workflow_runs, so the runs have to be real rows.
  const runs: Record<string, string> = {};

  async function makeRun(ctx: TenantContext, key: string): Promise<void> {
    await withTenant(ctx, async (c) => {
      const campaignId = await createCampaign(c, `pdp test ${key}`, null);
      runs[key] = await createRun(c, campaignId);
    });
  }

  beforeAll(async () => {
    await migrate();
    await seed();

    const crm = await startMcpServer({ name: 'crm-pdp', version: '0.0.0', port: 0, register: registerCrm, requireAuth: true });
    crmUrl = crm.url; servers.push(crm);

    const esp = await startMcpServer({ name: 'esp-pdp', version: '0.0.0', port: 0, register: registerEsp, requireAuth: true });
    espUrl = esp.url; servers.push(esp);

    const analytics = await startMcpServer({ name: 'analytics-pdp', version: '0.0.0', port: 0, register: registerAnalytics, requireAuth: false });
    analyticsUrl = analytics.url; servers.push(analytics);

    setMcpServers({ crm: crmUrl, esp: espUrl, analytics: analyticsUrl, 'segment-py': 'http://127.0.0.1:31999' });

    for (const k of ['allow', 'deny', 'approval', 'redact']) await makeRun(acmeCtx, k);
    await makeRun(globexCtx, 'globex');
  });

  afterAll(async () => {
    await closeAllClients();
    for (const s of servers) await s.close();
    await closePools();
  });

  async function auditCount(runId: string, ctx: TenantContext = acmeCtx): Promise<number> {
    let rows: any[] = [];
    await withTenant(ctx, async (c) => { rows = await listAudit(c, { runId }); });
    return rows.length;
  }

  it('allow — acme marketer calls crm.get_segment_stats under threshold', async () => {
    resetEspState();
    const runId = runs['allow']!;
    const result = await guardedCall(acmeCtx, runId, 'segment', 'segment', 'crm.get_segment_stats', { inactive_days: 90 });
    expect(result.effect).toBe('allow');
    expect(result.decision.ruleId).not.toBe('default');
    expect(await auditCount(runId)).toBe(1);
  });

  it('deny — acme viewer cannot call esp.send_email', async () => {
    resetEspState();
    const viewer: TenantContext = { tenantId: '11111111-1111-1111-1111-111111111111', actor: 'viewer@acme.test', actorRole: 'viewer' };
    const runId = runs['deny']!;
    const result = await guardedCall(viewer, runId, 'send_email', 'channel', 'esp.send_email', { campaign_id: 'c1', recipients: ['a@b.com'], subject: 'T', body: 'H', amount_usd: 10 });
    expect(result.effect).toBe('deny');
    expect(await auditCount(runId)).toBe(1);
  });

  it('require_approval — acme marketer sends >$100 via esp.send_email', async () => {
    resetEspState();
    const runId = runs['approval']!;
    const result = await guardedCall(acmeCtx, runId, 'send_email', 'channel', 'esp.send_email', { campaign_id: 'c1', recipients: ['a@b.com'], subject: 'Big', body: 'Hi', amount_usd: 500 });
    expect(result.effect).toBe('require_approval');
    expect(result.decision.thresholdUsd).toBe(100);
    expect(await auditCount(runId)).toBe(1);

    let approvals: any[] = [];
    await withTenant(acmeCtx, async (c) => { approvals = await listApprovals(c, 'pending'); });
    expect(approvals.filter((a: any) => a.runId === runId).length).toBe(1);
  });

  it('globex — marketer auto-allowed due to high threshold', async () => {
    resetEspState();
    const runId = runs['globex']!;
    const result = await guardedCall(globexCtx, runId, 'send_email', 'channel', 'esp.send_email', { campaign_id: 'c1', recipients: ['a@b.com'], subject: 'T', body: 'H', amount_usd: 500 });
    expect(result.effect).toBe('allow');
    expect(await auditCount(runId, globexCtx)).toBe(1);
  });

  it('redacts arguments according to policy', async () => {
    resetEspState();
    const runId = runs['redact']!;
    await guardedCall(acmeCtx, runId, 'send_email', 'channel', 'esp.send_email', { campaign_id: 'c1', recipients: ['a@b.com'], subject: 'Secret', body: 'Confidential', amount_usd: 500 });
    let argsRedacted: any;
    await withTenant(acmeCtx, async (c) => {
      const rows = await listAudit(c, { runId });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      argsRedacted = rows[0]!.argsRedacted;
    });
    expect(argsRedacted).toBeDefined();
    // The policy declares `recipients` redacted; the raw list must never reach the log.
    expect(argsRedacted.recipients).toBe('[REDACTED]');
    expect(JSON.stringify(argsRedacted)).not.toContain('a@b.com');
    expect(argsRedacted.amount_usd).toBe(500);
  });
});
