# ADR-003 — MCP is the only integration boundary; direct SDK calls from agents are banned

- **Status:** accepted
- **Date:** 2026-07-31

## Context

An agent needs to reach the CRM, the email service provider, and the analytics store. The
path of least resistance is to import each vendor SDK into the agent process and let the
model call typed functions. It works on day one and becomes unmanageable by month three:

- Every new integration is a new bespoke shape — different auth, different error semantics,
  different retry behaviour, different logging.
- Enforcement is scattered. A permission check written around the ESP call does not protect
  the CRM call added later by someone else.
- Credentials live in the agent process, so the blast radius of a prompt-injection bug is
  "everything the process can reach".
- The unit of reuse is the agent, not the capability. A second agent needing the same
  capability copies code.

## Decision

**Every capability an agent may exercise is an MCP tool served by an MCP server, and every
call passes through the policy gateway inside the control plane.**

Rules, enforced by construction rather than by convention:

1. Agents receive no network clients, no API keys, and no database handles. Their only
   effector is `guardedCall(ctx, runId, stepId, agentId, tool, args)`.
2. `guardedCall` evaluates the PDP first, writes an audit record for *every* outcome, and only
   then — on `allow` — opens the MCP call. There is no code path from an agent to a raw
   `client.callTool`.
3. Tool names are namespaced `<server>.<tool>` (`esp.send_email`), so policy rules can glob a
   whole server (`esp.*`) without knowing its tool list.
4. Transport is **Streamable HTTP** with the November-2025 spec's auth model: OAuth 2.1 with
   PKCE, resource-server metadata discovery, short-lived tokens bound to a tenant.
5. **No token passthrough.** A token minted for the control plane is never forwarded to an
   upstream system, and a token from a user session is never used as an MCP credential.
   Each hop mints its own. This is the single most commonly violated rule in MCP deployments
   and the one that turns a confused-deputy bug into a cross-tenant breach.

## Consequences

**Positive**

- One place to enforce permissions, one place to audit, one shape to test. The policy matrix
  test covers all integrations at once because they are all the same kind of object.
- Adding a capability is additive: write a tool, add a rule. No agent code changes.
- Integrations become independently deployable and independently ownable, and they can be
  written in any language (ADR-007).
- Prompt injection cannot escalate beyond the tool surface the policy allows for that
  tenant/role, because the model never holds a credential.

**Negative**

- An extra network hop and serialization per call. Measurable but small relative to LLM
  latency; the audit write is the more interesting cost at volume.
- Everything must be expressed as a tool, including things that would be one line of SQL.
  That friction is intentional but it *is* friction.
- MCP is a young spec. Auth in particular moved twice in 2025. Mitigation: the auth surface
  is isolated in `packages/mcp-common/src/oauth.ts`; the rest of the code never touches it.
- The demo AS is deliberately minimal (in-memory, no login UI). Production requires a real
  IdP — see the "what is mocked" section of the README.

**Rejected alternatives**

- *Direct SDK calls with a decorator/middleware for permission checks.* Rejected: enforcement
  by convention, and nothing prevents a future contributor from calling the SDK directly.
- *A homegrown internal "tool API" instead of MCP.* Rejected: same architecture, none of the
  ecosystem. MCP buys client compatibility, and the constraint of an external spec is a
  feature — it prevents the boundary from quietly absorbing business logic.
