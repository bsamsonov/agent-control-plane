/**
 * Tests for the mcp-common OAuth 2.1 + PKCE harness and MCP server.
 *
 * Real HTTP via fetch against a server on port 0.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startMcpServer,
  generateCodeVerifier,
  computeS256Challenge,
} from '../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run the full PKCE authorize + token flow against the given server, return the access_token. */
async function doPkceFlow(serverUrl: string, tenant = 'acme'): Promise<{
  token: string;
  code: string;
  codeVerifier: string;
}> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeS256Challenge(codeVerifier);
  const redirectUri = 'http://localhost:1/callback';

  // Step 1 — GET /authorize
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
  expect(code).toBeTruthy();

  // Step 2 — POST /token
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
  expect(data.access_token).toBeTruthy();
  expect(data.token_type).toBe('Bearer');

  return { token: data.access_token as string, code, codeVerifier };
}

// ---------------------------------------------------------------------------
// Test suite – server with requireAuth, normal TTL
// ---------------------------------------------------------------------------

describe('OAuth 2.1 + PKCE harness', () => {
  let serverUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const result = await startMcpServer({
      name: 'test-server',
      version: '0.0.0',
      port: 0,
      requireAuth: true,
      oauth: { tokenTTL: 60_000 }, // 1 min – long enough for all normal tests
      register: (s) => {
        s.registerTool(
          'hello',
          { description: 'A simple greeting tool' },
          async () => ({
            content: [{ type: 'text' as const, text: 'Hello, world!' }],
          }),
        );
      },
    });
    serverUrl = result.url;
    close = result.close;
  });

  afterAll(async () => {
    await close();
  });

  // --- Metadata endpoints ---

  it('exposes OAuth protected-resource metadata', async () => {
    const resp = await fetch(
      `${serverUrl}/.well-known/oauth-protected-resource`,
    );
    expect(resp.status).toBe(200);
    const body: any = await resp.json();
    expect(body.resource).toBe(`${serverUrl}/mcp`);
    expect(body.bearer_methods_supported).toContain('header');
  });

  it('exposes OAuth authorization-server metadata', async () => {
    const resp = await fetch(
      `${serverUrl}/.well-known/oauth-authorization-server`,
    );
    expect(resp.status).toBe(200);
    const body: any = await resp.json();
    expect(body.response_types_supported).toContain('code');
    expect(body.code_challenge_methods_supported).toContain('S256');
  });

  // --- PKCE flow ---

  it('completes full PKCE flow and returns a valid token', async () => {
    const { token } = await doPkceFlow(serverUrl);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects wrong code_verifier (S256 mismatch)', async () => {
    const { code } = await doPkceFlow(serverUrl);

    // Try to exchange with a different verifier
    const wrongVerifier = generateCodeVerifier();
    const tokenResp = await fetch(`${serverUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        code_verifier: wrongVerifier,
        client_id: 'test-client',
      }),
    });
    expect(tokenResp.status).toBe(400);
    const data = (await tokenResp.json()) as Record<string, unknown>;
    expect(data.error).toBe('invalid_grant');
  });

  it('rejects code reuse (single-use codes)', async () => {
    const { code, codeVerifier } = await doPkceFlow(serverUrl);

    // Code was already consumed by doPkceFlow — try again
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
    expect(tokenResp.status).toBe(400);
    const data = (await tokenResp.json()) as Record<string, unknown>;
    expect(data.error).toBe('invalid_grant');
  });

  // --- 401 shape ---

  it('returns 401 with WWW-Authenticate header for unauthenticated /mcp', async () => {
    const resp = await fetch(`${serverUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(401);
    const wwwAuth = resp.headers.get('www-authenticate');
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth!.toLowerCase()).toContain('bearer');
  });

  // --- /healthz ---

  it('serves /healthz without auth', async () => {
    const resp = await fetch(`${serverUrl}/healthz`);
    expect(resp.status).toBe(200);
    const body: any = await resp.json();
    expect(body).toEqual({ ok: true });
  });

  // --- MCP: tool call with valid token ---

  it('allows MCP tool call with a valid Bearer token', async () => {
    const { token } = await doPkceFlow(serverUrl);

    const transport = new StreamableHTTPClientTransport(
      new URL(`${serverUrl}/mcp`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    );
    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
    );

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'hello',
        arguments: {},
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toBe('Hello, world!');
    } finally {
      await client.close();
    }
  });

  // --- MCP: no token → 401 ---

  it('rejects MCP client connection without a token', async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${serverUrl}/mcp`),
    );
    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
    );

    // connect without auth — should fail
    await expect(client.connect(transport)).rejects.toThrow();
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Test suite – expired token (separate server with TTL=1)
// ---------------------------------------------------------------------------

describe('expired token', () => {
  let expiredServerUrl: string;
  let expiredClose: () => Promise<void>;

  beforeAll(async () => {
    const result = await startMcpServer({
      name: 'test-server-expiry',
      version: '0.0.0',
      port: 0,
      requireAuth: true,
      oauth: { tokenTTL: 1 }, // token expires almost instantly
      register: (s) => {
        s.registerTool(
          'hello',
          { description: 'A simple greeting tool' },
          async () => ({
            content: [{ type: 'text' as const, text: 'Hello!' }],
          }),
        );
      },
    });
    expiredServerUrl = result.url;
    expiredClose = result.close;
  });

  afterAll(async () => {
    await expiredClose();
  });

  it('rejects an expired token with 401', async () => {
    const { token } = await doPkceFlow(expiredServerUrl);

    // Token with TTL=1ms is already expired by the time we send the next request
    const resp = await fetch(`${expiredServerUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });

    expect(resp.status).toBe(401);
    const wwwAuth = resp.headers.get('www-authenticate');
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth!.toLowerCase()).toContain('bearer');
  });
});
