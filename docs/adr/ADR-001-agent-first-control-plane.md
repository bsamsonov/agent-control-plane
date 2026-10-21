# ADR-001 — Agent-first control plane, not a chatbot bolted onto the product

- **Status:** accepted
- **Date:** 2026-07-31
- **Deciders:** architecture owner (POC)

## Context

The existing product is a working B2B martech platform: campaigns, segments, sending,
analytics, all driven by humans clicking through a UI. The ask is "make it agent-first".

There are two ways to read that ask, and they lead to very different systems.

**Reading A — assistant on the side.** Add a chat panel. The LLM answers questions about
the data and, at most, pre-fills forms. Cheap, ships in two sprints, demos well.

**Reading B — control plane.** Agents become a *first-class actor class* in the system,
alongside human users. They get identities, permissions, budgets, an audit trail, and a
supervised path to executing real side effects. The chat box is an incidental detail.

Reading A is where most teams end up by default, and it is why so many "AI features" plateau:
the assistant can advise but never act, so the value ceiling is the user's typing speed.
It also quietly creates a security problem — the assistant usually inherits the session
user's full privileges, because no one modelled agent authority separately.

## Decision

Build **Reading B**. The unit of design is not "a conversation" but **a supervised run**:
a durable workflow with a tenant, an initiating actor, a plan, a sequence of policy-checked
tool calls, approvals, compensations, and a complete audit record.

Concretely this means the POC treats the following as the product surface, in priority order:

1. The **policy decision point** in front of every tool call.
2. The **durable workflow** that can suspend on a human decision and survive a restart.
3. The **audit and trace view** that explains what an agent did and why it was allowed to.

The brief-to-campaign scenario exists only to give those three something to be about.

## Consequences

**Positive**

- Agent authority is modelled explicitly, so it can be *granted incrementally*
  (see `docs/MIGRATION-STRATEGY.md`) instead of being all-or-nothing on launch day.
- The blast radius of a bad LLM output is bounded by policy, not by prompt engineering.
  A jailbroken planner still cannot spend $10,000, because the PDP does not read prompts.
- Every run is reconstructable after the fact. This is the difference between "the AI did
  something weird" as an unfalsifiable complaint and as a bug report with a trace id.
- The same machinery serves autonomy levels 0→3 without redesign: advisory mode is just a
  policy where every side-effecting tool is `require_approval`.

**Negative / costs**

- Substantially more infrastructure before the first useful output. A chat panel is a week;
  this is the better part of a quarter for a real team.
- Requires product decisions that organisations find uncomfortable: who may approve what,
  what an agent is allowed to spend, what happens when it is wrong.
- Latency is worse. Every tool call takes a policy round trip and an audit write.
- The demo is less flashy. "It paused and asked permission" is a harder sell to a
  non-technical audience than a streaming chat response, even though it is the harder thing
  to build.

**Rejected alternatives**

- *Chat assistant with tool calling and no PDP.* Rejected: authority = session user's
  authority. Unshippable in a multi-tenant B2B product where a marketer's mistake spends a
  customer's money.
- *Rules engine with no LLM.* Rejected: the planning step over an open-ended brief is
  precisely where the LLM earns its place. Everything downstream of the plan is deliberately
  deterministic.

## Verification

The demo proves the decision rather than asserting it: the same brief, submitted by two
tenants with different policies, produces different execution paths — one pauses for a human,
one runs unattended — with no code difference between them.
