# ADR-006 — Durable workflows, idempotency and compensation for human-in-the-loop runs

- **Status:** accepted
- **Date:** 2026-07-31

## Context

A campaign run pauses for a human approval. In a real organisation that pause is not 30
seconds — it is overnight, or over a weekend. During it the control plane will be deployed,
scaled down, OOM-killed, or restarted. Meanwhile some of the run's steps have already caused
irreversible side effects: a budget was debited, an ESP campaign object was created.

This produces three requirements that ordinary request/response code does not satisfy:

1. **Durability** — run state survives process death.
2. **Idempotency** — resuming must not re-execute a step whose side effect already happened.
3. **Compensation** — a failure after an irreversible step must be *undone*, not merely logged.

## Decision

**State lives in Postgres, never only in memory.**

- `workflow_runs` holds `status`, `cursor_step` and a `snapshot` JSONB.
- `step_results` is an idempotency ledger with primary key `(run_id, step_id)`. Before a step
  runs, the ledger is checked; a row means "already done, reuse the output, skip the effect".
  After it runs, the output is written *before* the cursor advances.
- Nothing about a run is held in a process-local map. A second instance of the control plane
  can resume a run started by the first.

**Suspension is a state, not a thread.** On `require_approval` the workflow persists its
snapshot, sets `status='suspended'`, creates the approval row and **returns**. No timer, no
held connection, no blocked coroutine. `POST /api/approvals/:id/decide` loads the run and
calls `resume(runId)`, which starts from `cursor_step`. A suspended run costs one database row.

**Retries are bounded and only for transient failures**: 3 attempts with 100/200/400 ms
exponential backoff. A policy `deny` is never retried — it is a decision, and retrying a
decision is how you build a system that argues with its own security layer.

**Compensation is an explicit step, not a `finally` block.** The demo path: `send_email`
debits the budget through the ESP and then fails (fault-injected by the `__FAIL__` marker in
the subject). The workflow runs `refund_campaign` for the same amount, records the
compensation in `step_results`, and marks the run `compensated` — a status distinct from both
`failed` and `done`, because "we failed and cleaned up" is a different operational fact from
"we failed and left money on the floor".

This is a saga, deliberately, not a distributed transaction. There is no two-phase commit
across an ESP and a CRM, and pretending otherwise is the classic mistake.

**Rejected: keeping the paused run in memory with a callback.** Works until the first deploy.
This is the single most common way agent demos fail in production, and the restart step in the
demo exists specifically to show it has been avoided.

**Rejected: replaying from the start on resume.** Cheap to implement, and it re-sends email.
Idempotency is not optional once side effects are real.

**Rejected: event sourcing the whole run.** Better auditability, materially more machinery.
The audit log already provides the forensic record; the ledger provides correctness. That
split is enough here.

## Consequences

**Positive**

- The restart demo is a genuine proof, not theatre: `docker kill` the control plane mid-pause,
  bring it back, the approval is still pending, approving resumes at the same step.
- Horizontal scaling is possible in principle, since no instance owns a run.
- The `compensated` status makes saga behaviour visible in the UI rather than buried in logs.

**Negative**

- Every step boundary is a database write. Fine at POC volume; a batching or outbox strategy
  becomes necessary well before high throughput (`SCALE-LIMITS.md`).
- Snapshots must stay serializable, which bans closures, live clients and class instances in
  step outputs. This is a real constraint on how steps are written.
- Idempotency is only as strong as the `step_id` scheme. Ids are static per workflow
  definition; a loop over recipients would need composite ids, which the POC does not exercise.
- Concurrent resume attempts (double-clicking approve) are guarded by the unique constraint on
  `(run_id, step_id)` in `approvals` and the ledger, but a production system needs an explicit
  advisory lock per run.

## Verification

`apps/control-plane/test/workflow-resume.test.ts` suspends a run, discards the workflow
instance entirely, builds a fresh one, resumes, and asserts both that the run completes and
that the already-completed steps did not execute a second time.
`saga.test.ts` asserts the refund and the `compensated` status.
