# Migration strategy — turning a working martech platform agent-first

> The premise: there is a profitable product with real customers, real money moving through it,
> and a team that must keep shipping. Nothing below is allowed to require a rewrite, a freeze,
> or a leap of faith. Agent authority is **earned incrementally and measured**.

The organising idea: **autonomy is a dial, not a switch**, and the dial is a policy document
per tenant (ADR-005). The same code runs at every phase. What changes is data.

---

## Phase 0 — Inventory the side effects (2–3 weeks, no agent code)

You cannot govern actions you have not enumerated. Before any agent exists:

1. **Catalogue every side effect** the product can produce: sends, spend, data exports,
   schema writes, third-party writes, anything irreversible or externally visible.
2. For each one record: who may trigger it today, what it costs, whether it is reversible,
   what "undo" means, and what the worst plausible mistake looks like in money and in
   reputation.
3. **Classify by reversibility**, not by technical difficulty:
   - *Reversible* — drafts, segments, schedules. Undo is cheap.
   - *Compensable* — spend that can be refunded, campaigns that can be paused.
   - *Irreversible* — email that has landed in an inbox, an ad that has served.
4. Identify the **existing choke points**. Most products already have a service layer where
   sends and spend funnel through. Those functions are the future MCP tools. If no such choke
   point exists, creating one is the real first project — and it is worth doing whether or not
   agents ever ship.

Deliverable: a spreadsheet, an owner per side effect, and a first draft of the tool namespace.
No agent has been written. This phase alone usually surfaces two or three governance gaps that
predate the AI conversation entirely.

**Exit criterion:** every irreversible action in the product has a named owner and a documented
blast radius.

---

## Phase 1 — Agents as advisory (4–6 weeks) — **zero production risk**

Deploy the control plane with **every side-effecting tool set to `require_approval`**, or
simply not exposed. Agents read, plan, and propose. Humans execute in the existing UI.

- Read-only MCP servers wrap existing read APIs. No writes exist yet.
- The planner produces a plan; the UI shows it beside the human's normal workflow.
- **The point of this phase is data collection.** Every proposal, every human decision, and
  every divergence between the two is recorded. That corpus is what makes the next phase an
  evidence-based decision rather than an act of faith.

Metrics that gate progression:
- *Proposal acceptance rate* — of plans a human could have executed, how many did they accept
  unchanged? Below ~70% the agent is not ready and the honest move is to stay here.
- *Time-to-decision* — how long humans spend reviewing. If reviewing costs more than doing,
  the agent is producing work, not removing it.
- *Divergence taxonomy* — where the agent is wrong: bad segment logic, bad copy, bad budget
  reasoning? Each category has a different fix, and only one of them is "prompt engineering".

Risk here is genuinely zero: the agent has no write capability. That makes it an easy sell
internally and a cheap way to build organisational trust — which is the actual bottleneck.

---

## Phase 2 — Strangler: existing endpoints become MCP tools (6–10 weeks)

Now agents get *bounded* execution rights, using the strangler-fig pattern.

1. **Wrap, don't rewrite.** Each existing service function is exposed as an MCP tool. The
   legacy code path is untouched; the MCP server is a thin adapter over it. Human UI and agent
   both call the same underlying function, so behaviour cannot drift.
2. **Start with the reversible tier only** — create draft, build segment, schedule (but do not
   send). Policy allows these; everything compensable or irreversible remains
   `require_approval`.
3. **Introduce thresholds** where money is involved: allow below $X, escalate above it. The
   first $X should be embarrassingly small. It is a dial (ADR-005), and moving it is a row
   update with an audit record, not a deploy.
4. **Compensation before autonomy.** No tool graduates from `require_approval` until its
   compensating action exists, is tested, and has been exercised in staging (ADR-006). "We
   will add the refund path later" is how a saga becomes a spreadsheet reconciliation.
5. **Per-tenant rollout.** One friendly design-partner tenant first. Policy is per tenant, so
   this needs no feature flags and no branching.

What is explicitly **not** touched:
- Billing and payment paths. Agents never touch money movement directly, only campaign spend
  through the ESP, and only within a budget the tenant set.
- Authentication and identity. Agents get their own identities; the human auth system is
  untouched.
- The existing UI. It remains fully functional and authoritative. If the agent layer is turned
  off entirely, the product still works — that is the rollback plan, and it should stay true
  permanently.

---

## Phase 3 — Widening the policy boundary (continuous)

Autonomy expands per tool, per tenant, driven by the metrics from Phase 1 and by the audit log
from Phase 2.

- A tool graduates from `require_approval` to `allow` for a tenant when its approval rate has
  been near-total over a meaningful sample, and its compensation path has been exercised.
- Thresholds rise gradually. Each rise is one auditable row change; each is reversible in
  seconds.
- Budget guards remain permanently. Even a fully trusted agent stops at 90% utilization
  (ADR-005) — trust in the agent is not trust in the world.
- **Automatic demotion:** an anomaly detector on the audit stream (spike in spend, spike in
  denials, unusual recipient volume) can revert a tenant's policy to the previous version
  without a deploy. The policy being data is what makes this possible.

---

## Rollback

Three levels, all rehearsed rather than theoretical:

| Level | Action | Time | Blast radius |
|---|---|---|---|
| Tool | Set that tool to `deny` in one tenant's policy | seconds | one capability, one tenant |
| Tenant | Restore the tenant's previous policy version | seconds | one tenant |
| System | Stop the control plane | minutes | agents gone; product unaffected |

The system-level rollback is only credible because of the Phase-2 rule that the legacy path is
never removed. That rule is the entire insurance policy, and it should outlive the migration.

---

## What this costs, honestly

Phase 0 is analysis, cheap in money and expensive in political will. Phases 1–2 for a real
team are a quarter to two quarters — the MCP wrapping is mechanical, but the governance
conversations (who approves what, what may an agent spend) are not, and they are the critical
path. Phase 3 never ends; it becomes ordinary product operation.

The cost that surprises people is **observability and audit**, not the agents. Every tool call
produces a policy decision and an audit record; at production volume that is a data
engineering problem with real infrastructure cost (see `SCALE-LIMITS.md`). Budgeting for the
agent framework and not for the audit pipeline is the standard mistake.
