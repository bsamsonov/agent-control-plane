/**
 * Tests for mcp-fake-crm tools.
 *
 * Starts a real server on port 0, authenticates via PKCE, and calls every tool
 * with the MCP SDK client. Verifies response shapes, determinism, and tenant
 * divergence.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startMcpServer,
  generateCodeVerifier,
  computeS256Challenge,
} from '@macp/mcp-common';
import { register } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function doPkceFlow(serverUrl: string, tenant: string): Promise<string> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeS256Challenge(codeVerifier);
  const redirectUri = 'http://localhost:1/callback';

  const authUrl = new URL(`${serverUrl}/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', 'test-client');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('tenant', tenant);
  authUrl.searchParams.set('scope', 'tools');

  const authResp = await fetch(authUrl.toString(), { redirect: 'manual' });
  expect(authResp.status).toBe(302);
  const location = authResp.headers.get('location')!;
  const code = new URL(location).searchParams.get('code')!;

  const tokenResp = await fetch(`${serverUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      client_id: 'test-client',
    }),
  });
  expect(tokenResp.status).toBe(200);
  const data = (await tokenResp.json()) as Record<string, unknown>;
  return data.access_token as string;
}

async function connectClient(
  serverUrl: string,
  token: string,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${serverUrl}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
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

describe('mcp-fake-crm tools', () => {
  let serverUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const result = await startMcpServer({
      name: 'mcp-fake-crm-test',
      version: '0.0.0',
      port: 0,
      requireAuth: true,
      register,
    });
    serverUrl = result.url;
    close = result.close;
  });

  afterAll(async () => {
    await close();
  });

  // --- search_customers ---

  it('search_customers returns valid shape', async () => {
    const token = await doPkceFlow(serverUrl, 'acme');
    const client = await connectClient(serverUrl, token);

    try {
      const result = await client.callTool({
        name: 'search_customers',
        arguments: { inactive_days: 90 },
      });
      const data = parseResult(result) as {
        customers: Array<{ id: string; email: string; last_purchase_at: string; ltv_usd: number }>;
        total: number;
      };

      expect(Array.isArray(data.customers)).toBe(true);
      expect(typeof data.total).toBe('number');
      expect(data.customers.length).toBeLessThanOrEqual(data.total);
      expect(data.customers.length).toBeGreaterThan(0);

      const first = data.customers[0]!;
      expect(typeof first.id).toBe('string');
      expect(typeof first.email).toBe('string');
      expect(typeof first.last_purchase_at).toBe('string');
      expect(typeof first.ltv_usd).toBe('number');
    } finally {
      await client.close();
    }
  });

  it('search_customers respects limit', async () => {
    const token = await doPkceFlow(serverUrl, 'acme');
    const client = await connectClient(serverUrl, token);

    try {
      const result = await client.callTool({
        name: 'search_customers',
        arguments: { inactive_days: 0, limit: 3 },
      });
      const data = parseResult(result) as {
        customers: Array<unknown>;
        total: number;
      };
      expect(data.customers.length).toBeLessThanOrEqual(3);
    } finally {
      await client.close();
    }
  });

  it('search_customers is deterministic (same tenant → same result)', async () => {
    const token = await doPkceFlow(serverUrl, 'acme');
    const client = await connectClient(serverUrl, token);

    const call1 = await client.callTool({
      name: 'search_customers',
      arguments: { inactive_days: 180 },
    });
    const call2 = await client.callTool({
      name: 'search_customers',
      arguments: { inactive_days: 180 },
    });
    await client.close();

    expect(parseResult(call1)).toEqual(parseResult(call2));
  });

  it('search_customers differs between tenants', async () => {
    const tokenAcme = await doPkceFlow(serverUrl, 'acme');
    const clientAcme = await connectClient(serverUrl, tokenAcme);

    const resultAcme = await clientAcme.callTool({
      name: 'search_customers',
      arguments: { inactive_days: 0 },
    });
    await clientAcme.close();

    const tokenGlobex = await doPkceFlow(serverUrl, 'globex');
    const clientGlobex = await connectClient(serverUrl, tokenGlobex);

    const resultGlobex = await clientGlobex.callTool({
      name: 'search_customers',
      arguments: { inactive_days: 0 },
    });
    await clientGlobex.close();

    const dataAcme = parseResult(resultAcme) as { total: number };
    const dataGlobex = parseResult(resultGlobex) as { total: number };

    // acme has 40 customers, globex has 25 — should differ
    expect(dataAcme.total).not.toBe(dataGlobex.total);
  });

  // --- get_segment_stats ---

  it('get_segment_stats returns valid shape', async () => {
    const token = await doPkceFlow(serverUrl, 'acme');
    const client = await connectClient(serverUrl, token);

    try {
      const result = await client.callTool({
        name: 'get_segment_stats',
        arguments: { inactive_days: 365 },
      });
      const data = parseResult(result) as {
        size: number;
        avg_ltv_usd: number;
        channels: { email: number; ads: number };
      };

      expect(typeof data.size).toBe('number');
      expect(typeof data.avg_ltv_usd).toBe('number');
      expect(typeof data.channels.email).toBe('number');
      expect(typeof data.channels.ads).toBe('number');
    } finally {
      await client.close();
    }
  });

  it('get_segment_stats is deterministic', async () => {
    const token = await doPkceFlow(serverUrl, 'globex');
    const client = await connectClient(serverUrl, token);

    const r1 = await client.callTool({
      name: 'get_segment_stats',
      arguments: { inactive_days: 200 },
    });
    const r2 = await client.callTool({
      name: 'get_segment_stats',
      arguments: { inactive_days: 200 },
    });
    await client.close();

    expect(parseResult(r1)).toEqual(parseResult(r2));
  });

  it('get_segment_stats differs between tenants', async () => {
    const tokenAcme = await doPkceFlow(serverUrl, 'acme');
    const clientAcme = await connectClient(serverUrl, tokenAcme);
    const rAcme = await clientAcme.callTool({
      name: 'get_segment_stats',
      arguments: { inactive_days: 365 },
    });
    await clientAcme.close();

    const tokenGlobex = await doPkceFlow(serverUrl, 'globex');
    const clientGlobex = await connectClient(serverUrl, tokenGlobex);
    const rGlobex = await clientGlobex.callTool({
      name: 'get_segment_stats',
      arguments: { inactive_days: 365 },
    });
    await clientGlobex.close();

    expect(parseResult(rAcme)).not.toEqual(parseResult(rGlobex));
  });

  // --- health ---

  it('/healthz returns ok', async () => {
    const resp = await fetch(`${serverUrl}/healthz`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
  });
});
