/**
 * Shared MCP server harness: Streamable HTTP transport, optional OAuth 2.1 + PKCE auth.
 *
 * Use this as the base for every @macp/mcp-* server package.
 */

import express from 'express';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InMemoryOAuthServer } from './oauth.js';
import type { OAuthServerOptions } from './oauth.js';

// Re-export for tests
export { InMemoryOAuthServer } from './oauth.js';
export type { OAuthServerOptions };

// --- types ---

export interface McpServerOptions {
  name: string;
  version: string;
  port: number;
  register: (server: McpServer) => void;
  /** When true, requests must carry Authorization: Bearer <token> issued by the built-in AS. */
  requireAuth?: boolean;
  /** Options forwarded to the in-memory OAuth AS (e.g. tokenTTL for tests). */
  oauth?: OAuthServerOptions;
}

// --- startMcpServer ---

export async function startMcpServer(
  o: McpServerOptions,
): Promise<{ close(): Promise<void>; url: string }> {
  const app = express();

  // OAuth authorization server (in-memory, demo-grade)
  const oauthServer = new InMemoryOAuthServer(o.oauth);

  // --- HTTP listener (ephemeral port, then configure OAuth base URL) ---
  const httpServer = http.createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(o.port, resolve));

  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to get server address');
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  oauthServer.setBaseUrl(baseUrl);

  // --- OAuth routes ---
  app.get(
    '/.well-known/oauth-protected-resource',
    (req, res) => oauthServer.protectedResourceMetadata(req, res),
  );
  app.get(
    '/.well-known/oauth-authorization-server',
    (req, res) => oauthServer.authorizationServerMetadata(req, res),
  );
  app.get('/authorize', (req, res) => oauthServer.authorize(req, res));
  app.post('/token', express.json(), (req, res) => oauthServer.token(req, res));

  // --- MCP transport route ---
  // In stateless mode each request gets a fresh transport (required by the SDK —
  // reusing a stateless transport across requests causes message ID collisions).
  const mcpHandlers: Array<(req: any, res: any, next: any) => void> = [];

  // Parse JSON body for POST requests
  mcpHandlers.push(express.json());

  // Optional bearer auth
  if (o.requireAuth) {
    mcpHandlers.push(
      requireBearerAuth({
        verifier: oauthServer,
        resourceMetadataUrl: `${baseUrl}/.well-known/oauth-protected-resource`,
      }),
    );
  }

  // Transport handler — creates a fresh McpServer + transport per request
  mcpHandlers.push(async (req, res) => {
    const server = new McpServer({ name: o.name, version: o.version });
    o.register(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
      enableJsonResponse: true, // direct JSON response (no SSE long-polling)
    });

    await server.connect(transport);
    try {
      await transport.handleRequest(req, res, req.body);
    } finally {
      await server.close();
    }
  });

  app.use('/mcp', ...mcpHandlers);

  // --- Health ---
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  return {
    url: baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

// --- helpers ---

/**
 * Extracts tenant from the validated bearer token or the X-MACP-Tenant header (dev mode).
 */
export function tenantFromRequest(req: { headers: Record<string, string | string[] | undefined>; auth?: { extra?: { tenantId?: unknown } } }): string {
  const auth = req.auth;
  if (auth?.extra?.tenantId && typeof auth.extra.tenantId === 'string') {
    return auth.extra.tenantId;
  }
  const header = req.headers['x-macp-tenant'];
  if (typeof header === 'string') return header;
  return '';
}
