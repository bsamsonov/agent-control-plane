/**
 * Tests for mcp-analytics tools.
 *
 * Starts a server on port 0 (no auth), connects with the MCP SDK client,
 * and calls every tool. Verifies response shapes, determinism, and tenant
 * divergence via campaign_id.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startMcpServer } from '@macp/mcp-common';
import { register } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function connectClient(serverUrl: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${serverUrl}/mcp`),
  );
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function parseResult(result: unknown): unknown {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('mcp-analytics tools', () => {
  let serverUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const result = await startMcpServer({
      name: 'mcp-analytics-test',
      version: '0.0.0',
      port: 0,
      requireAuth: false,
      register,
    });
    serverUrl = result.url;
    close = result.close;
  });

  afterAll(async () => {
    await close();
  });

  // --- get_campaign_metrics ---

  it('get_campaign_metrics returns valid shape', async () => {
    const client = await connectClient(serverUrl);

    try {
      const result = await client.callTool({
        name: 'get_campaign_metrics',
        arguments: { campaign_id: 'camp-acme-1' },
      });
      const data = parseResult(result) as {
        sent: number;
        delivered: number;
        opened: number;
        clicked: number;
        revenue_usd: number;
        open_rate: number;
        click_rate: number;
      };

      expect(typeof data.sent).toBe('number');
      expect(typeof data.delivered).toBe('number');
      expect(typeof data.opened).toBe('number');
      expect(typeof data.clicked).toBe('number');
      expect(typeof data.revenue_usd).toBe('number');
      expect(typeof data.open_rate).toBe('number');
      expect(typeof data.click_rate).toBe('number');

      // Delivered ≤ sent, opened ≤ delivered, clicked ≤ opened
      expect(data.delivered).toBeLessThanOrEqual(data.sent);
      expect(data.opened).toBeLessThanOrEqual(data.delivered);
      expect(data.clicked).toBeLessThanOrEqual(data.opened);
    } finally {
      await client.close();
    }
  });

  it('get_campaign_metrics is deterministic', async () => {
    const client = await connectClient(serverUrl);

    try {
      const r1 = await client.callTool({
        name: 'get_campaign_metrics',
        arguments: { campaign_id: 'camp-acme-42' },
      });
      const r2 = await client.callTool({
        name: 'get_campaign_metrics',
        arguments: { campaign_id: 'camp-acme-42' },
      });
      expect(parseResult(r1)).toEqual(parseResult(r2));
    } finally {
      await client.close();
    }
  });

  it('get_campaign_metrics differs between tenants', async () => {
    const client = await connectClient(serverUrl);

    try {
      const rAcme = await client.callTool({
        name: 'get_campaign_metrics',
        arguments: { campaign_id: 'camp-acme-1' },
      });
      const rGlobex = await client.callTool({
        name: 'get_campaign_metrics',
        arguments: { campaign_id: 'camp-globex-1' },
      });

      // Same campaign number, different tenant → different metrics
      expect(parseResult(rAcme)).not.toEqual(parseResult(rGlobex));
    } finally {
      await client.close();
    }
  });

  // --- get_benchmarks ---

  it('get_benchmarks returns valid shape for email', async () => {
    const client = await connectClient(serverUrl);

    try {
      const result = await client.callTool({
        name: 'get_benchmarks',
        arguments: { channel: 'email' },
      });
      const data = parseResult(result) as {
        open_rate: number;
        click_rate: number;
        cpc_usd: number;
      };
      expect(typeof data.open_rate).toBe('number');
      expect(typeof data.click_rate).toBe('number');
      expect(typeof data.cpc_usd).toBe('number');
      expect(data.open_rate).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('get_benchmarks returns valid shape for ads', async () => {
    const client = await connectClient(serverUrl);

    try {
      const result = await client.callTool({
        name: 'get_benchmarks',
        arguments: { channel: 'ads' },
      });
      const data = parseResult(result) as {
        open_rate: number;
        click_rate: number;
        cpc_usd: number;
      };
      expect(data.cpc_usd).toBeGreaterThan(data.open_rate); // ads cost more
    } finally {
      await client.close();
    }
  });

  it('get_benchmarks is deterministic', async () => {
    const client = await connectClient(serverUrl);

    try {
      const r1 = await client.callTool({
        name: 'get_benchmarks',
        arguments: { channel: 'email' },
      });
      const r2 = await client.callTool({
        name: 'get_benchmarks',
        arguments: { channel: 'email' },
      });
      expect(parseResult(r1)).toEqual(parseResult(r2));
    } finally {
      await client.close();
    }
  });

  // --- health ---

  it('/healthz returns ok', async () => {
    const resp = await fetch(`${serverUrl}/healthz`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
  });
});
