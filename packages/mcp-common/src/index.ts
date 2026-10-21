/**
 * @macp/mcp-common — shared harness for MCP servers.
 *
 * Re-exports the server bootstrap, OAuth helpers, and type contracts.
 */

export { startMcpServer, tenantFromRequest, InMemoryOAuthServer } from './server.js';
export type { McpServerOptions, OAuthServerOptions } from './server.js';
export { verifyToken, computeS256Challenge, generateCodeVerifier } from './oauth.js';
