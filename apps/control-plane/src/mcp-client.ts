/**
 * MCP client — manages lazy OAuth + MCP Client per (tenant, server).
 *
 * All MCP calls must go through pdp.ts first; this module is an internal
 * dependency that does the raw wire call.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { generateCodeVerifier, computeS256Challenge } from '@macp/mcp-common';

// Server configuration (set by server.ts at startup)
let serverUrls: Record<string, string> = {};

/** Register MCP server URLs for the control plane. */
export function setMcpServers(urls: Record<string, string>): void {
  serverUrls = { ...urls };
}

// Cache of connected clients keyed by "serverUrl::tenant"
const clientCache = new Map<string, Client>();

function cacheKey(serverUrl: string, tenant: string): string {
  return `${serverUrl}::${tenant}`;
}

/**
 * Complete PKCE OAuth flow against an MCP server for the given tenant.
 * Returns an access_token.
 */
async function obtainToken(serverUrl: string, tenant: string): Promise<string> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeS256Challenge(codeVerifier);
  const redirectUri = 'http://localhost:1/callback';

  const authUrl = new URL(`${serverUrl}/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', 'control-plane');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('tenant', tenant);
  authUrl.searchParams.set('scope', 'tools');

  const authResp = await fetch(authUrl.toString(), { redirect: 'manual' });
  if (authResp.status !== 302) {
    throw new Error(`OAuth authorize failed: ${authResp.status}`);
  }
  const location = authResp.headers.get('location')!;
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error('No code in authorize redirect');

  const tokenResp = await fetch(`${serverUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      client_id: 'control-plane',
    }),
  });
  if (tokenResp.status !== 200) {
    throw new Error(`OAuth token exchange failed: ${tokenResp.status}`);
  }
  const data = (await tokenResp.json()) as Record<string, unknown>;
  return data.access_token as string;
}

/**
 * Direct MCP tool call (no policy enforcement — that's pdp.ts's job).
 * @param tenant  Tenant slug ("acme" or "globex")
 * @param server  Server key ("crm", "esp", "analytics", "segment-py")
 * @param toolName  Tool name without server prefix
 * @param args  Tool arguments (JSON-serializable)
 */
export async function callTool(
  tenant: string,
  server: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const serverUrl = serverUrls[server];
  if (!serverUrl) {
    throw new Error(`Unknown MCP server: ${server}`);
  }

  // Segment-py has no auth
  if (server === 'segment-py') {
    const key = cacheKey(serverUrl, tenant);
    let client = clientCache.get(key);
    if (!client) {
      const transport = new StreamableHTTPClientTransport(
        new URL(`${serverUrl}/mcp`),
      );
      client = new Client({ name: 'control-plane', version: '1.0.0' });
      await client.connect(transport);
      clientCache.set(key, client);
    }
    const result = await client.callTool({ name: toolName, arguments: args });
    return unwrapToolResult(result);
  }

  // Auth-required servers (crm, esp, analytics)
  const key = cacheKey(serverUrl, tenant);
  let client = clientCache.get(key);
  if (!client) {
    const token = await obtainToken(serverUrl, tenant);
    const transport = new StreamableHTTPClientTransport(
      new URL(`${serverUrl}/mcp`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    );
    client = new Client({ name: 'control-plane', version: '1.0.0' });
    await client.connect(transport);
    clientCache.set(key, client);
  }
  const result = await client.callTool({ name: toolName, arguments: args });
  return unwrapToolResult(result);
}

/** For tests — close all cached clients. */
export async function closeAllClients(): Promise<void> {
  for (const client of clientCache.values()) {
    await client.close().catch(() => {});
  }
  clientCache.clear();
}


/**
 * Turn an MCP tool result into a value or an exception.
 *
 * A tool that fails answers with `isError: true` and a human-readable text block, not with a
 * transport error. Parsing that text as JSON produced "Unexpected token 'F'" and hid the real
 * failure — which mattered, because the compensation path keys off the message. Failures are
 * raised as Errors carrying the tool's own text.
 */
/**
 * A failure reported by the tool itself (`isError: true`): a business outcome such as
 * "insufficient budget", not a transport problem. The workflow does not retry these.
 */
export class McpToolError extends Error {
  override name = 'McpToolError';
}

function unwrapToolResult(result: unknown): unknown {
  const r = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = r.content?.find((c) => c.type === 'text')?.text;
  if (r.isError) {
    throw new McpToolError(text ?? 'MCP tool returned an error with no message');
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A tool that answers with prose rather than JSON is still a successful call.
    return text;
  }
}
