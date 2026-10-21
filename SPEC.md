# SPEC — frozen interfaces (MACP)

> Contracts below are **fixed**. Modules are written in parallel by different agents.
> Do not rename files, exports, or change signatures. If something seems wrong, implement
> it as written anyway.

Monorepo: pnpm workspaces, ESM (`"type": "module"`), TypeScript strict, NodeNext resolution.
All intra-repo imports use package names (`@macp/policy`), never relative cross-package paths.
Because moduleResolution is NodeNext, **relative imports inside a package must carry the
`.js` extension** (`./eval.js`), even though the file is `.ts`. Tests run with `vitest run`.

## 1. `@macp/policy` — Policy Decision Point

Files: `packages/policy/src/types.ts` and `packages/policy/src/seed-policies.ts`
(**both already written — read them, do not modify**), plus to be written:
`packages/policy/src/eval.ts`, `packages/policy/src/redact.ts`,
`packages/policy/src/schema.ts`, `packages/policy/src/index.ts`.

```ts
// eval.ts
export function evaluate(doc: PolicyDocument, input: PolicyInput): PolicyDecision;
// redact.ts
export function redactArgs(args: Record<string, unknown>, paths: string[]): Record<string, unknown>;
// schema.ts  (zod v4)
export const policyDocumentSchema: z.ZodType<PolicyDocument>;
export function parsePolicyDocument(raw: unknown): PolicyDocument; // throws on invalid
// index.ts re-exports everything above plus all of types.ts
```

Evaluation semantics (exactly this, tests assert it):
1. Rules are scanned in array order. A rule matches when **every** present clause in `when`
   matches; an absent clause is a wildcard.
   - `roles`: `input.actorRole` ∈ list.
   - `agents`: `input.agentId` ∈ list, or list contains `"*"`.
   - `tools`: exact match, or prefix glob `"esp.*"` matching `"esp.anything"`; `"*"` matches all.
   - `args`: for each `path -> allowedValues`, the dot-path value of `input.args` must be
     `===` one of the allowed values (after `String()` comparison fallback for numbers).
   - `budgetUtilizationOver: u`: matches when
     `(budget.spentUsd + (budget.pendingUsd ?? 0)) / budget.limitUsd > u`. `limitUsd <= 0`
     is treated as utilization `Infinity`.
2. **First** matching rule wins. No merging of effects.
3. If the winning rule's `effect === 'allow'` and `requireApprovalOverUsd` is set:
   read the amount from `args` at `amountField ?? 'amount_usd'`. Coerce numeric strings.
   If the amount is **strictly greater** than the threshold, the effect becomes
   `require_approval` with `thresholdUsd` and `amountUsd` populated and reason
   `` `amount $${amount} exceeds auto-approve threshold $${threshold}` ``.
   A missing/NaN amount is treated as `0` (i.e. stays `allow`).
   `requireApprovalOverUsd` is ignored for `deny` and `require_approval` rules.
4. No rule matched → `effect = doc.defaultEffect`, `ruleId = 'default'`,
   `reason = 'no rule matched; tenant default applies'`.
5. `redact` in the result = `doc.alwaysRedact ?? []` ∪ winning rule's `redact ?? []`,
   deduplicated, order: alwaysRedact first, then rule's.
6. `reason` comes from the winning rule's `reason` when set, except in case 3 where the
   threshold message wins. Otherwise `` `rule ${rule.id} -> ${effect}` ``.
7. `evaluate` is **pure**: no I/O, no Date.now (use `input.now`), no throwing on odd args.

`redactArgs`: returns a deep clone with each dot-path replaced by the string `"[REDACTED]"`.
Supports `a.b.c` and `a[0].b` and the trailing wildcard `a.*` (redact every own key one level
below `a`). Missing paths are ignored silently. Never mutates the input.

### Test artifact (this is the repository's flagship test)
`packages/policy/test/matrix.test.ts` — a table-driven matrix over
(role × tool × amount × budget utilization) with **at least 30 cases**, using the two seed
policy documents imported from `./src/seed-policies.js` (`ACME_POLICY`, `GLOBEX_POLICY`).
Must cover: viewer denied writes; marketer send_email over/under threshold; admin bypass;
budget-exhausted deny; unknown tool → default; redaction paths merged; `esp.*` glob.
Plus `packages/policy/test/redact.test.ts` (≥8 cases) and
`packages/policy/test/schema.test.ts` (valid + 4 invalid documents).
No `skip`, no `xfail`, assertions must check the decision object, not just the effect.

## 2. `@macp/db` — Postgres access, RLS tenant context, migrations, seed

Files: `packages/db/src/pool.ts`, `tenant.ts`, `crypto.ts`, `repos.ts`, `migrate.ts`,
`seed.ts`, `fixtures.ts`, `index.ts`. SQL in `packages/db/sql/` is **already written — do not modify**.

```ts
// pool.ts
export function getPool(): pg.Pool;               // uses process.env.DATABASE_URL
export function getAdminPool(): pg.Pool;          // DATABASE_URL_ADMIN
export async function closePools(): Promise<void>;

// tenant.ts
export interface TenantContext { tenantId: string; actor: string; actorRole: Role; }
/**
 * Opens a transaction, runs `SET LOCAL app.tenant_id = $1`, executes fn, commits.
 * Rolls back and rethrows on error. The client passed to fn MUST be used for all
 * queries inside — that is the only way RLS sees the setting.
 */
export function withTenant<T>(ctx: TenantContext, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
/** Escape hatch for migrations/seed only. Uses the admin pool, no RLS setting. */
export function withAdmin<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;

// crypto.ts — envelope encryption for tenant_credentials
export function sealCredential(plain: Record<string, unknown>): string;   // -> base64 blob
export function openCredential(blob: string): Record<string, unknown>;
// AES-256-GCM, random 12-byte IV, key = sha256(MACP_MASTER_KEY). Blob = base64(iv|tag|ct).

// migrate.ts — runs every packages/db/sql/*.sql in filename order on the ADMIN pool,
// idempotently (files are written to be re-runnable). `export async function migrate()`,
// plus a CLI entrypoint when run directly.

// seed.ts — `export async function seed()` + CLI entrypoint. Truncates business tables
// and inserts the fixtures from fixtures.ts using the ADMIN pool.
```

`repos.ts` — thin, all functions take `(c: pg.PoolClient, ...)` and never open their own tx:
```ts
export async function insertAudit(c, row: AuditRow): Promise<void>;
export async function listAudit(c, opts: { limit?: number; runId?: string }): Promise<AuditRow[]>;
export async function createCampaign(c, brief: string, createdBy: string | null): Promise<string>;
export async function setCampaignStatus(c, campaignId: string, status: string): Promise<void>;
export async function createRun(c, campaignId: string): Promise<string>;
export async function getRun(c, runId: string): Promise<RunRow | null>;
export async function saveSnapshot(c, runId: string, snapshot: unknown, status: string, cursorStep: string | null): Promise<void>;
export async function listRuns(c, opts?: { status?: string }): Promise<RunRow[]>;
export async function getStepResult(c, runId: string, stepId: string): Promise<StepRow | null>;
export async function putStepResult(c, runId: string, stepId: string, status: 'ok'|'failed'|'compensated', output: unknown): Promise<void>;
export async function createApproval(c, a: NewApproval): Promise<string>;
export async function listApprovals(c, status?: string): Promise<ApprovalRow[]>;
export async function getApproval(c, id: string): Promise<ApprovalRow | null>;
export async function decideApproval(c, id: string, decision: 'approved'|'rejected', decidedBy: string | null, note: string | null): Promise<ApprovalRow | null>;
export async function getPolicy(c): Promise<PolicyDocument>;         // for current tenant
export async function getBudget(c): Promise<BudgetState>;
export async function addSpend(c, amountUsd: number): Promise<void>; // may be negative (compensation)
```
Row types (`AuditRow`, `RunRow`, `StepRow`, `ApprovalRow`, `NewApproval`) are exported from
`repos.ts`; field names are camelCase mirrors of the SQL columns.

`fixtures.ts` exports:
```ts
export const TENANTS: Array<{ id: string; slug: 'acme'|'globex'; name: string; plan: string }>;
export const USERS: Array<{ id: string; tenantSlug: string; email: string; role: Role }>;
```
Fixed UUIDs (hardcode these, tests and demo rely on them):
- acme  tenant `11111111-1111-1111-1111-111111111111`
- globex tenant `22222222-2222-2222-2222-222222222222`
Users: `admin@acme.test` (admin), `marketer@acme.test` (marketer), `viewer@acme.test` (viewer),
`marketer@globex.test` (marketer), `admin@globex.test` (admin). Any stable UUIDs.

Policy documents are **not** defined here: import `ACME_POLICY` / `GLOBEX_POLICY` from
`@macp/policy` and insert them into the `policies` table (acme -> ACME_POLICY,
globex -> GLOBEX_POLICY). Also seed `budget_state`: acme limit 1000 spent 0,
globex limit 5000 spent 0. Also seed one `tenant_credentials` row per system per tenant
using `sealCredential`. For reference, the seeded policies mean:
- **acme**: default deny; viewers read-only; marketer `esp.send_email` auto-allowed up to
  $100 and require_approval above; admin up to $5000; a budget guard flips every `esp.*`
  call to require_approval past 90% utilization.
- **globex**: default deny; no budget guard; marketer/admin thresholds effectively
  unreachable, so the same brief runs unattended. This contrast is the demo's
  multi-tenancy proof.

### Tests
`packages/db/test/rls.test.ts` — requires a live Postgres (skip the whole file via
`describe.skipIf(!process.env.DATABASE_URL)` is **not** allowed; instead the CI script starts
Postgres — assume it is running, and fail loudly if not). Must prove:
1. acme context sees exactly acme's campaigns; globex context sees exactly globex's.
2. Writing a row with a foreign tenant_id fails (RLS WITH CHECK violation).
3. **Negative test:** reading with `app.tenant_id` unset returns 0 rows (never all rows).
4. `SET LOCAL` does not leak across pool checkouts: after `withTenant(acme)`, a raw pool
   query without a setting returns 0 rows.
`packages/db/test/crypto.test.ts` — round-trip, tamper detection (flipped byte → throws).

## 3. MCP servers

`@macp/mcp-common` (`packages/mcp-common/src/index.ts`) exports the shared harness:
```ts
export interface McpServerOptions {
  name: string; version: string; port: number;
  register: (server: McpServer) => void;   // McpServer from @modelcontextprotocol/sdk
  /** When true, requests must carry Authorization: Bearer <token> issued by the built-in AS. */
  requireAuth?: boolean;
}
export function startMcpServer(o: McpServerOptions): Promise<{ close(): Promise<void>; url: string }>;
/** Extracts tenant from the validated bearer token or the X-MACP-Tenant header (dev mode). */
export function tenantFromRequest(req: import('express').Request): string;
```
Transport: **Streamable HTTP** (`StreamableHTTPServerTransport` from
`@modelcontextprotocol/sdk/server/streamableHttp.js`) mounted at `POST/GET/DELETE /mcp`,
stateless mode (`sessionIdGenerator: undefined`) — simplest thing that survives restarts.
Also expose `GET /healthz` → `{"ok":true}`.

OAuth 2.1 + PKCE (in `packages/mcp-common/src/oauth.ts`, minimal, in-memory, demo-grade):
- `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`
  metadata documents.
- `GET /authorize?response_type=code&client_id&redirect_uri&code_challenge&code_challenge_method=S256&state&scope`
  → immediately redirects with a code (no login UI; the tenant is taken from the `tenant`
  query param).
- `POST /token` with `grant_type=authorization_code`, `code`, `code_verifier` → validates
  S256 challenge, returns `{access_token, token_type:"Bearer", expires_in: 300, scope}`.
  Tokens are opaque, 5-minute TTL, bound to a tenant, stored in memory.
- `export function verifyToken(token: string): { tenantId: string; scope: string } | null;`
- Unauthenticated request when `requireAuth` → HTTP 401 with
  `WWW-Authenticate: Bearer resource_metadata="<url>"`.
- **No token passthrough:** tokens minted here are never forwarded upstream; document this
  in a comment.
Tests: `packages/mcp-common/test/oauth.test.ts` — happy path, wrong verifier rejected,
expired token rejected, 401 shape.

### `@macp/mcp-fake-crm` (port 3101, `requireAuth: true`)
Tools (zod input schemas, all return `content: [{type:'text', text: JSON.stringify(result)}]`):
- `search_customers({ inactive_days: number, limit?: number })` →
  `{ customers: Array<{id, email, last_purchase_at, ltv_usd}>, total: number }`
- `get_segment_stats({ inactive_days: number })` →
  `{ size: number, avg_ltv_usd: number, channels: {email: number, ads: number} }`
Data is deterministic per tenant (seeded PRNG from tenantId) so demo runs are reproducible;
acme must yield a visibly different segment size than globex.

### `@macp/mcp-fake-esp` (port 3102, `requireAuth: true`)
- `get_budget({})` → `{ limit_usd, spent_usd, remaining_usd }` (in-memory per tenant, seeded
  from `{acme: {limit:1000, spent:0}, globex: {limit:5000, spent:0}}`)
- `create_campaign({ name: string, channel: 'email'|'ads', amount_usd: number })` →
  `{ campaign_id: string, status: 'created' }`
- `send_email({ campaign_id: string, recipients: string[], subject: string, body: string, amount_usd: number })`
  → debits the budget, returns `{ sent: number, message_id: string, charged_usd: number }`.
  Fails with an MCP error when `amount_usd > remaining_usd`.
  **Fault injection for the saga demo:** if `subject` contains the marker `"__FAIL__"`, the
  budget is debited and *then* the tool throws — this is what the compensating step undoes.
- `refund_campaign({ campaign_id: string, amount_usd: number })` → `{ refunded_usd }`
  (the compensation).

### `@macp/mcp-analytics` (port 3103, `requireAuth: false`, read-only)
- `get_campaign_metrics({ campaign_id: string })` → deterministic
  `{ sent, delivered, opened, clicked, revenue_usd, open_rate, click_rate }`
- `get_benchmarks({ channel: 'email'|'ads' })` → `{ open_rate, click_rate, cpc_usd }`

Each MCP package: `src/server.ts` with a `main()` that starts the server when run directly,
and `export function register(server: McpServer): void` so tests can mount it in-process.
Tests `packages/mcp-*/test/tools.test.ts`: start the server on an ephemeral port, connect with
the SDK `Client` + `StreamableHTTPClientTransport`, call every tool, assert shapes; assert
determinism (same tenant → same result twice) and tenant divergence (acme ≠ globex).

## 4. `services/segment-py` — Python MCP server (port 3104)

Standalone `uv`/pip project: `pyproject.toml`, `segment_py/server.py`, `segment_py/scoring.py`,
`tests/test_scoring.py`, `Dockerfile`, `README.md`. Python 3.12.
Use the official `mcp` package (`pip install "mcp[cli]"`) with **Streamable HTTP** transport
(`mcp.server.fastmcp.FastMCP(name=..., host=..., port=3104)`, `mcp.run(transport="streamable-http")`,
tools mounted at `/mcp`). No auth (it sits behind the control plane).
Tools:
- `score_segment(customers: list[dict], inactive_days: int) -> dict` — pure pandas/numpy-free
  scoring: recency/frequency/monetary buckets → `{ "segment_size": int, "avg_score": float,
  "tiers": {"hot": n, "warm": n, "cold": n}, "recommended_budget_usd": float }`
- `explain_scoring() -> str` — one paragraph, for the trace view.
Scoring logic lives in `scoring.py` as pure functions and is fully unit-tested (≥10 cases,
including empty input, all-cold input, boundary buckets). `server.py` is a thin adapter.
Test command: `cd services/segment-py && uv run pytest -q`.

## 5. `@macp/control-plane` — orchestration, PDP enforcement, HTTP API

Files: `apps/control-plane/src/{server.ts,auth.ts,mcp-client.ts,pdp.ts,agents.ts,llm.ts,
workflow.ts,routes/*.ts}` + tests in `apps/control-plane/test/`.

- `auth.ts` — dev auth: header `X-MACP-User: marketer@acme.test` (or `Authorization: Bearer
  dev:<email>`) resolves to `{ tenantId, actor, actorRole }` via the users table. No passwords;
  documented as a deliberate POC shortcut.
- `mcp-client.ts` — one MCP `Client` per (tenant, server), lazily created, with the OAuth
  client-credentials-ish PKCE dance against the fake AS; `callTool(ctx, server, tool, args)`.
  **All calls go through `pdp.ts` first — never expose a raw callTool to agents.**
- `pdp.ts`:
  ```ts
  export type GuardResult =
    | { effect: 'allow'; result: unknown; decision: PolicyDecision }
    | { effect: 'deny'; decision: PolicyDecision }
    | { effect: 'require_approval'; decision: PolicyDecision; approvalId: string };
  export async function guardedCall(ctx: TenantContext, runId: string | null, stepId: string,
    agentId: string, tool: string, args: Record<string, unknown>): Promise<GuardResult>;
  ```
  Loads the tenant policy + budget, evaluates, writes an `audit_log` row **for every outcome**
  (with redacted args), and only on `allow` performs the MCP call. On `require_approval`
  it creates a pending `approvals` row (idempotent on `(run_id, step_id)`).
- `workflow.ts` — the durable `run_campaign` workflow, implemented as a **plain TypeScript
  step engine over Postgres** (not a framework workflow). ADR-002 explains why: the durability
  contract is the thing under test, so it must not be delegated. Mastra is used only for the
  LLM-facing agents in `agents.ts`. Steps, in order:
  `plan` → `segment` → `content` → `create_campaign` → `send_email` → `analytics` → `summarize`.
  Requirements: every step's output is persisted via `putStepResult` before advancing;
  a step whose `step_results` row exists is **skipped on resume** (idempotency);
  `require_approval` suspends the run (`status='suspended'`, snapshot saved) and returns;
  `resume(runId)` continues from `cursor_step` — never from the beginning;
  transient failures retry 3× with exponential backoff (100/200/400ms);
  if `send_email` fails after the budget was charged, run the compensating
  `refund_campaign` step and mark the run `compensated`.
- `llm.ts` — model config for any OpenAI-compatible endpoint (`LLM_BASE_URL`, `LLM_API_KEY`,
  `LLM_MODEL`). **When `MACP_FAKE_LLM=1`, agents return deterministic canned output** so the
  whole demo and all tests run with zero network. This flag is what CI uses.
- `agents.ts` — Mastra agents `planner`, `content`, `summarizer`. Planner emits structured
  output (zod) `{ steps: Array<{ id, title, tool?, rationale }> }`; the budget is extracted from
  the brief deterministically, never taken from the model.
- HTTP API (Hono, port `CONTROL_PLANE_PORT`):
  - `POST /api/campaigns` `{brief}` → `{campaignId, runId}`, starts the run in the background
  - `GET  /api/runs/:id` → run + steps + audit entries
  - `GET  /api/runs/:id/stream` → SSE of step events (`event: step`, JSON data)
  - `GET  /api/approvals?status=pending` → list
  - `POST /api/approvals/:id/decide` `{decision:'approved'|'rejected', note?}` → resumes the run
  - `GET  /api/audit?runId=&limit=` → audit rows
  - `GET  /api/me` → tenant + user + policy summary
  - `GET  /healthz`
  Every handler resolves a `TenantContext` and uses `withTenant`. No handler may touch the pool
  directly.
- **Restart durability**: nothing lives only in memory. On boot, `server.ts` calls
  `recoverRuns()` which re-attaches to runs in `status='running'` and marks them resumable.

Tests (`apps/control-plane/test/`), all with `MACP_FAKE_LLM=1` and in-process MCP servers:
`pdp.test.ts` (allow/deny/require_approval each produce exactly one audit row with correct
redaction), `workflow-resume.test.ts` (run suspends on approval, **a fresh workflow instance**
— simulating a process restart — resumes from the cursor and does not re-execute completed
steps), `saga.test.ts` (the `__FAIL__` path refunds and marks the run `compensated`),
`api.test.ts` (happy path over HTTP, cross-tenant approval decision returns 404).

## 6. `apps/web` — Next.js 16 App Router UI

Three screens, shadcn-free (plain Tailwind, no design work):
`/` brief form + SSE live plan; `/approvals` inbox with approve/reject + note;
`/traces` audit table with tenant/run filters and a drill-down drawer.
A tenant switcher in the header sets the `X-MACP-User` header used by the API client
(`lib/api.ts`). Server components fetch through the control plane base URL
`process.env.CONTROL_PLANE_URL ?? 'http://localhost:3001'`. No auth UI beyond the switcher.

## 7. Conventions

- Never log raw tool args; log the redacted version.
- Errors returned by the API: `{ error: { code, message } }` with a proper HTTP status.
- Every file starts with a short comment saying what it is and why it exists.
- Commit at the end: `git add -A && git commit -m "<scope>: <what>"`.
