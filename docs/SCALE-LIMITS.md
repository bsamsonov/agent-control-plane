# Scale limits — what breaks, when, and whether money fixes it

> This POC runs two tenants on a laptop. The interesting question is what happens at 1,000
> tenants and a few hundred thousand agent runs a month. Below is where each design decision
> stops holding, roughly when, and whether the fix is a cheque or a redesign.
>
> Numbers are order-of-magnitude engineering estimates, not benchmarks. The purpose is to show
> that the limits were considered, and to name the specific thing that breaks first.

---

## 1. Connection pool under RLS — **first thing to break**

**The design.** Every request takes a connection, opens a transaction, issues
`SET LOCAL app.tenant_id`, does its work, commits (ADR-004).

**Where it breaks.** `SET LOCAL` is transaction-scoped, which is what makes it safe — and what
makes it incompatible with *transaction-mode* connection pooling done naively. With PgBouncer
in transaction mode the setting is correct (it dies with the transaction) but every single
statement outside an explicit transaction becomes a hazard, so all tenant work must be wrapped
in transactions. That is already the rule here, but it must never be relaxed. Session-mode
pooling would pin a connection per client and cap concurrency at Postgres' `max_connections`
(a few hundred).

The sharper limit is arithmetic: at ~500 concurrent agent steps, each holding a connection for
the duration of an *LLM call* or an *MCP round trip*, the pool is exhausted long before the
database is busy. A step that holds a connection across a network call is the anti-pattern.

**Symptom.** Pool timeouts under load while Postgres CPU sits near idle.

**Fix — money, then redesign.**
- *Cheap:* never hold a connection across an LLM or MCP call. Read state, close, call, reopen
  to write. Costs an extra round trip; buys an order of magnitude. This is a code discipline
  issue and should be enforced by review, not hope.
- *Money:* PgBouncer in transaction mode, a bigger instance, read replicas for the audit and
  trace views.
- *Redesign, past ~5k tenants:* shard tenants across database clusters, or move the largest
  tenants to dedicated databases. The hybrid model — pooled small tenants, isolated large ones
  — is where most B2B SaaS ends up, and the tenant→cluster mapping is the new thing to build.

---

## 2. LLM cost and latency — **the budget item nobody forecasts correctly**

**The numbers.** A run in this POC makes ~4 model calls (plan, content ×2, summarize). At
roughly 3–8k tokens per call on a mid-tier model, a run is a few cents. 200,000 runs a month
is therefore in the low thousands of dollars — tolerable. The problem is variance: one tenant
with large briefs and long recipient context can be 20× the median, and cost is charged to
you while value accrues to them.

**Where it breaks.**
- Per-tenant cost is unbounded unless metered. `audit_log.cost_usd` exists for exactly this
  reason and must be aggregated into a per-tenant meter with enforcement, not just a report.
- p95 latency is dominated by the model, not by the platform. A four-call run is 10–30 seconds
  before any tool executes. Users interpret that as "broken" unless the plan streams.
- Rate limits are per-account at the provider, so a noisy tenant throttles everyone. Fair
  queuing per tenant is required, and it is not free to build.

**Fix — mostly money, partly design.** Prompt caching for the stable system/policy preamble;
route planning to a strong model and content generation to a cheap one; cache segment
descriptions; hard per-tenant monthly token budgets expressed as ordinary policy rules
(ADR-005 already supports amount thresholds — token budgets are the same mechanism).

---

## 3. Snapshot storage — **grows quietly, then dominates**

**The design.** Every step persists to `step_results`, and every suspend writes a
`workflow_runs.snapshot` (ADR-006).

**Where it breaks.** At ~10 steps and a few KB of snapshot per run, 200k runs a month is
single-digit GB per month of workflow state, plus the audit log. That is not a storage problem;
it is a *table bloat and vacuum* problem. `workflow_runs` is heavily updated (every step
advances the cursor), so it accumulates dead tuples fast, and its indexes degrade.

**Symptom.** Autovacuum falling behind on `workflow_runs`; approval-inbox queries getting
slower month over month for no apparent reason.

**Fix — money and a modest redesign.** Aggressive autovacuum settings on the hot tables;
partition `audit_log` by month and detach old partitions to cold storage; move snapshot bodies
out of the hot row into a separate table or object storage, keeping only the cursor and status
in `workflow_runs`; a retention policy — completed runs keep their audit record, not their
snapshot. Compliance requirements usually dictate audit retention, so this is a conversation
with legal as much as with engineering.

---

## 4. Audit write amplification — **the hidden cost of the whole design**

Every tool call writes an audit row *synchronously*, including denials (ADR-005). That is the
feature. At 200k runs × ~8 tool calls, that is ~1.6M rows a month — trivial. At 50 tool calls
per run and ten times the volume, it is 100M+ rows a month and the audit write is a meaningful
share of every call's latency.

**Fix.** Batch through an outbox table and a background writer, or ship to an append-only store
(ClickHouse, or object storage with a query layer) and keep only recent rows in Postgres. The
constraint that must not be traded away: **the decision must be durable before the side effect
happens**. Asynchronous audit is acceptable for `allow`-and-succeeded records; it is not
acceptable for the decision itself. Getting that distinction wrong turns the audit log from
evidence into an estimate.

---

## 5. Upstream rate limits and MCP fan-out

Real CRMs and ESPs have per-account rate limits, and agents are cheerfully parallel. A single
agent can generate more upstream calls in a minute than a human does in a day.

**Fix — redesign, and it is not optional in production.** A token-bucket limiter per
(tenant, upstream) in front of the MCP client; queue rather than fail; make the limiter's
decisions visible in the trace so "slow" is explainable. Circuit breakers per upstream so one
degraded vendor does not consume the whole worker pool. None of this exists in the POC and it
is the largest single gap between this repo and a production system.

---

## 6. Policy evaluation

Not a bottleneck and unlikely to become one: `evaluate` is a pure in-memory scan over a
document with tens of rules — microseconds. Loading the document is a database read, cacheable
per tenant with invalidation on write.

The real limit is **human**: a policy document with 200 hand-ordered rules is unmaintainable,
because first-match-wins makes shadowing invisible to the author (ADR-005). Past a few dozen
rules the answer is a policy language with tooling — OPA/Rego with a test suite and a linter —
not more JSON. That migration is anticipated in the PDP's signature.

---

## 7. Multi-region

Not addressed at all. Customers with data-residency requirements would need
regional deployments with regional databases, which turns the tenant→database mapping of §1
into a tenant→region mapping and forces a decision about where the control plane's own
metadata lives. Flagged as known-unknown; sizing it honestly requires the actual customer
contracts.

---

## 8. More than one control-plane instance

The workflow engine assumes a single process: `recoverRuns()` restarts every run left in
`running`, and nothing stops two instances from picking up the same run.
- *Engineering:* a lease on `workflow_runs` — claim with `SELECT … FOR UPDATE SKIP LOCKED`, store
  `leased_by` and `lease_expires_at`, renew while a step executes, and let recovery take only
  expired leases. The idempotency ledger already makes a double execution of a *completed* step
  harmless; the lease closes the window for a step that is in flight.
- *Money:* does not help. This is a correctness fix, not a capacity one.

---

## Summary

| Limit | Bites at | Fix |
|---|---|---|
| Connection pool under RLS | ~500 concurrent steps | discipline, then PgBouncer, then sharding |
| LLM cost/latency variance | any real volume | metering as policy, model routing, caching |
| Snapshot/audit bloat | ~6–12 months of production | partitioning, retention, offloaded bodies |
| Synchronous audit writes | ~10× POC-era volume | outbox + append-only store |
| Upstream rate limits | immediately, in production | per-tenant limiters and circuit breakers |
| Policy document size | ~50 rules | OPA/Rego with tests |
| Second control-plane instance | the first horizontal scale-out | a lease on `workflow_runs` |

**What this POC is not.** A production multi-tenant agent platform with real integrations,
a real IdP, rate limiting, regional isolation and a hardened audit pipeline is a
$60–120k, several-month engagement for a small team. This repository demonstrates the
architecture and the hard parts of the control layer; it does not replace that work and does
not claim to. What it does claim: the decisions above were made deliberately, and each one has
a documented trigger for revisiting it.
