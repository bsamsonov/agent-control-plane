/**
 * Minimal in-memory OAuth 2.1 + PKCE authorization server (demo-grade).
 *
 * Token passthrough is forbidden: tokens minted here are never forwarded
 * upstream. This is a deliberate design constraint of the demo AS.
 */

import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import crypto from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';

/** Minimal request shape — enough for the OAuth handlers. */
interface ExpressReq {
  query: Record<string, unknown>;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

interface ExpressRes {
  json(body: unknown): void;
  status(code: number): ExpressRes;
  redirect(url: string): void;
}

// --- helpers ---

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function computeS256Challenge(verifier: string): string {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

function randomString(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

// --- store types ---

interface StoredCode {
  codeChallenge: string;
  tenantId: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  expiresAt: number; // epoch ms
}

interface StoredToken {
  token: string;
  tenantId: string;
  scope: string;
  clientId: string;
  expiresAt: number; // epoch ms
}

// --- config ---

export interface OAuthServerOptions {
  /** Token time-to-live in milliseconds (default 5 min). Injectable for tests. */
  tokenTTL?: number;
  /** Authorization code time-to-live in milliseconds (default 60s). */
  codeTTL?: number;
}

// --- OAuth server ---

export class InMemoryOAuthServer implements OAuthTokenVerifier {
  private codes = new Map<string, StoredCode>();
  private tokens = new Map<string, StoredToken>();
  private baseUrl = '';
  readonly tokenTTL: number;
  readonly codeTTL: number;

  constructor(opts: OAuthServerOptions = {}) {
    this.tokenTTL = opts.tokenTTL ?? 5 * 60 * 1000; // 5 min
    this.codeTTL = opts.codeTTL ?? 60 * 1000; // 60s
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, '');
  }

  /** Clean up expired entries (best-effort). */
  private reap(): void {
    const now = Date.now();
    for (const [k, v] of this.codes) {
      if (now > v.expiresAt) this.codes.delete(k);
    }
    for (const [k, v] of this.tokens) {
      if (now > v.expiresAt) this.tokens.delete(k);
    }
  }

  // --- route handlers ---

  /** GET /.well-known/oauth-protected-resource */
  protectedResourceMetadata(_req: ExpressReq, res: ExpressRes): void {
    res.json({
      resource: `${this.baseUrl}/mcp`,
      authorization_servers: [`${this.baseUrl}/`],
      bearer_methods_supported: ['header'],
    });
  }

  /** GET /.well-known/oauth-authorization-server */
  authorizationServerMetadata(_req: ExpressReq, res: ExpressRes): void {
    res.json({
      issuer: this.baseUrl,
      authorization_endpoint: `${this.baseUrl}/authorize`,
      token_endpoint: `${this.baseUrl}/token`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }

  /** GET /authorize */
  async authorize(req: ExpressReq, res: ExpressRes): Promise<void> {
    this.reap();
    const q = req.query;
    const clientId = typeof q.client_id === 'string' ? q.client_id : '';
    const redirectUri = typeof q.redirect_uri === 'string' ? q.redirect_uri : '';
    const codeChallenge = typeof q.code_challenge === 'string' ? q.code_challenge : '';
    const method = typeof q.code_challenge_method === 'string' ? q.code_challenge_method : '';
    const state = typeof q.state === 'string' ? q.state : '';
    const scope = typeof q.scope === 'string' ? q.scope : '';
    const tenantId = typeof q.tenant === 'string' ? q.tenant : '';

    if (!clientId || !redirectUri || !codeChallenge || method !== 'S256') {
      const errParams = new URLSearchParams({ error: 'invalid_request', error_description: 'Missing required parameters' });
      if (state) errParams.set('state', state);
      res.redirect(`${redirectUri}?${errParams.toString()}`);
      return;
    }

    const code = randomString();
    this.codes.set(code, {
      codeChallenge,
      tenantId,
      clientId,
      redirectUri,
      scope,
      expiresAt: Date.now() + this.codeTTL,
    });

    const params = new URLSearchParams({ code });
    if (state) params.set('state', state);
    res.redirect(`${redirectUri}?${params.toString()}`);
  }

  /** POST /token */
  async token(req: ExpressReq, res: ExpressRes): Promise<void> {
    this.reap();
    const { grant_type, code, code_verifier, client_id } = req.body as Record<string, unknown>;

    if (grant_type !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }

    if (typeof code !== 'string' || !code) {
      res.status(400).json({ error: 'invalid_request', error_description: 'code required' });
      return;
    }

    const stored = this.codes.get(code);
    if (!stored || Date.now() > stored.expiresAt) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'code expired or not found' });
      return;
    }

    // Validate PKCE S256
    if (typeof code_verifier !== 'string' || !code_verifier) {
      res.status(400).json({ error: 'invalid_request', error_description: 'code_verifier required' });
      return;
    }

    const expectedChallenge = computeS256Challenge(code_verifier);
    if (expectedChallenge !== stored.codeChallenge) {
      // Delete code on PKCE mismatch (prevent brute-force)
      this.codes.delete(code);
      res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier mismatch' });
      return;
    }

    // Delete code (single-use)
    this.codes.delete(code);

    const token = randomString();
    const expiresAt = Date.now() + this.tokenTTL;
    this.tokens.set(token, {
      token,
      tenantId: stored.tenantId,
      scope: stored.scope,
      clientId: stored.clientId,
      expiresAt,
    });

    res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: Math.floor(this.tokenTTL / 1000),
      scope: stored.scope || undefined,
    });
  }

  // --- OAuthTokenVerifier ---

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.reap();
    const stored = this.tokens.get(token);
    if (!stored || Date.now() > stored.expiresAt) {
      // Must be the SDK's typed error: a plain Error surfaces as HTTP 500 and the
      // client cannot tell "your token expired, go re-auth" from "the server broke".
      throw new InvalidTokenError('Invalid or expired token');
    }

    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scope ? stored.scope.split(' ') : [],
      // The SDK's bearer middleware rejects tokens without an expiry. Seconds, not ms.
      expiresAt: Math.floor(stored.expiresAt / 1000),
      extra: { tenantId: stored.tenantId },
    };
  }

  // --- public API (matches SPEC) ---

  /** Verify a bearer token. Returns tenant + scope info, or null if invalid/expired. */
  verifyToken(token: string): { tenantId: string; scope: string } | null {
    this.reap();
    const stored = this.tokens.get(token);
    if (!stored || Date.now() > stored.expiresAt) return null;
    return { tenantId: stored.tenantId, scope: stored.scope };
  }
}

/** Convenience export matching the SPEC signature. */
export function verifyToken(
  token: string,
  server: InMemoryOAuthServer,
): { tenantId: string; scope: string } | null {
  return server.verifyToken(token);
}
