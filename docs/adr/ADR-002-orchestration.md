# ADR-002 — Orchestration: an own step engine over Postgres; Mastra only for the agents

- **Status:** accepted (revised after implementation; the first draft chose Mastra workflows)
- **Date:** 2026-07-31

## Context

The control plane needs an orchestration layer with three non-negotiable properties:

1. **Durable suspend/resume.** A run pauses on a human approval and resumes *at that step*
   after the process has been killed and restarted — not replayed from the beginning.
2. **Human-in-the-loop as a normal outcome**, not an exception thrown through the call stack.
3. **Idiomatic TypeScript**, because the target codebase is Node/TS.

Nice to have: structured output from models, MCP support, tracing hooks.

## Options considered

**Mastra workflows.** TypeScript-native, snapshot-based suspend/resume, a Postgres store,
agents and MCP as first-class concepts. The first draft of this ADR picked it. During
implementation the durability contract turned out to be the thing this repository exists to
demonstrate and test: "a completed step is never re-executed, even across a crash" must be a
property *we* can assert, not one we inherit. Mastra's workflow API also moved between minor
versions while this was being built.

**LangGraph.js.** `interrupt()` plus a Postgres checkpointer is close to what is needed. But
the TS port trails the Python original, and its idioms are LangChain idioms that a Node team
does not share.

**Temporal.** The right answer for durability at scale and the honest benchmark. Rejected for
this POC on operational weight: a server, a worker fleet and its own data store break the
"clone and run" requirement and would dominate a reviewer's attention.

**Vercel AI SDK alone.** Good model abstraction and structured output; no workflow concept.

## Decision

- **Workflow:** a plain TypeScript step engine in `apps/control-plane/src/workflow.ts`, about
  600 lines, persisted in Postgres:
  - `step_results` is an idempotency ledger keyed by `(run_id, step_id)`. Every step's output is
    written before the cursor advances; on resume, steps with a ledger row are skipped.
  - `workflow_runs.snapshot` and `cursor_step` hold the run state; `require_approval` sets
    `status = 'suspended'` and returns.
  - Approving resumes from `cursor_step` under the run's original initiator; the approved call
    bypasses the PDP once and is audited as `approved_by_human`.
  - On boot, `recoverRuns()` restarts runs left in `running`.
  - Transient MCP failures retry 3× with backoff; a failed `send_email` after the budget was
    charged runs the compensating `refund_campaign` and marks the run `compensated`.
- **Agents:** Mastra (`@mastra/core`) for the three LLM-facing agents — planner, content,
  summarizer — on any OpenAI-compatible endpoint, with zod-validated structured output.
  Agents have no tools: every side effect goes through the workflow and the policy gateway.

## Consequences

**Positive**

- The durability property is tested directly (`workflow-resume.test.ts`, `recover.test.ts`)
  and shown in the demo by killing the process mid-approval.
- No framework sits between a policy decision and a side effect; the audit trail and the
  ledger are ordinary tables a reviewer can query.
- Replacing the engine with Temporal touches `workflow.ts` only: steps are plain functions.

**Negative**

- Retries, compensation and recovery are hand-written. That is roughly a week of work a
  framework would have given for free, and it has to be maintained.
- No visual workflow tooling, no built-in timers or schedules.
- Single-process execution: recovery assumes one control plane instance. Running several
  needs a lease on `workflow_runs` (`SELECT … FOR UPDATE SKIP LOCKED`) — see
  `docs/SCALE-LIMITS.md`.

**Trigger to revisit:** runs longer than minutes, fan-out across workers, timers, or sagas
spanning services. At that point Temporal earns its operational cost.
