# ADR-005 — Permission model: an external PDP with declarative rules, and `require_approval` as a first-class outcome

- **Status:** accepted
- **Date:** 2026-07-31

## Context

"Can this agent do this?" is not the same question as "can this user do this?". It depends on
the tenant, the human on whose behalf the agent acts, the agent's own identity, the specific
tool, the *arguments* to that tool, and the tenant's remaining budget. RBAC answers the first
two and nothing else: `role=marketer` cannot distinguish sending to 50 recipients for $12 from
sending to 400,000 recipients for $9,000.

Two further constraints shaped the design. Permissions must be **changeable without a
deploy**, because the whole migration strategy (ADR-001, `MIGRATION-STRATEGY.md`) is about
widening agent authority gradually per tenant. And the answer "ask a human" must be a normal
answer, because in the first phases of adoption it is the *most common* answer.

## Decision

**A Policy Decision Point separated from the Policy Enforcement Point.**

- **PDP** (`packages/policy`): a pure function `evaluate(doc, input) -> decision`. No I/O, no
  clock, no database. Input is the tuple
  `(tenant, actor, actorRole, agentId, tool, args, budgetState, now)`.
- **PEP** (`apps/control-plane/src/pdp.ts`): loads the tenant's policy and budget, calls
  `evaluate`, writes the audit record, and only then performs or refuses the MCP call.
- **Rules are data** — JSONB in `policies.rule_json`, validated by a zod schema, editable per
  tenant at runtime.

**Four outcomes, not two:**

| Outcome | Meaning |
|---|---|
| `allow` | Execute now. |
| `deny` | Refuse. Terminal for that step; the agent is told and must re-plan. |
| `require_approval` | Suspend the run, create an approval request, wait for a human. |
| `allow` + `requireApprovalOverUsd` | Allow below a threshold, escalate above it. |

`require_approval` is **not an error**. It does not throw, it is not logged as a failure, and
it does not consume the retry budget. Treating it as an exception is the design mistake this
line exists to prevent: it leads to catch-blocks that either swallow the pause or abort the
run, and to metrics where "asked a human" is indistinguishable from "crashed".

**Evaluation semantics** are deliberately boring: rules are scanned in order, the first match
wins, no scoring, no merging of effects, and an unmatched request falls to the tenant's
`defaultEffect` — which is `deny` for both seeded tenants. Order-dependence is a real cost, but
it makes every decision explainable in one sentence ("rule `budget-guard` matched"), and
explainability is what an approver and an auditor both need.

**Every decision is audited**, including `deny` — denials are the highest-signal events in the
system — with arguments redacted according to paths declared by the policy itself
(`alwaysRedact` plus the winning rule's `redact`). Recipient lists and customer emails never
reach the log.

**Rejected: OPA/Rego as a sidecar.** The right answer at scale and the intended migration
target; rejected for the POC because a second runtime and a policy language would dominate the
reviewer's attention. The `evaluate` signature is deliberately shaped so it can be swapped for
an OPA call.

**Rejected: permissions in the system prompt.** Not a control. The model is untrusted input;
a control that the untrusted component can talk its way past is decoration.

## Consequences

**Positive**

- Purity makes the PDP exhaustively testable. The decision matrix (role × tool × amount ×
  budget utilization, 30+ cases) is the repository's flagship test and runs in milliseconds.
- Changing a tenant from "advisory" to "autonomous" is a row update, and the audit log shows
  exactly when it happened and what changed as a result.
- The budget guard demonstrates state-dependent authority: the same call is allowed at 40%
  utilization and escalated at 95%, with no code involved.

**Negative**

- First-match-wins means rule order is semantically significant, and a badly ordered document
  can shadow a rule silently. Mitigated by schema validation and by rules carrying ids that
  appear in the audit log, so shadowing is visible in production data.
- Argument-level rules are only as good as the argument shape. A tool that hides the amount
  inside a nested payload escapes the threshold check. Tool design is therefore part of the
  security review, not just an implementation detail.
- Per-call policy evaluation plus an audit write is two extra database round trips per tool
  call. See `SCALE-LIMITS.md` for where that stops being free.
