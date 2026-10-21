# ADR-007 — Polyglot agents: the Python agent is a separate process behind MCP

- **Status:** accepted
- **Date:** 2026-07-31

## Context

Segment scoring is data work. The people who own that logic are analysts and data scientists,
and their tools — pandas, scikit-learn, statsmodels, the whole scientific stack — are Python.
The control plane is TypeScript. Rewriting the scoring logic in TS would mean the people who
understand it can no longer change it, which is an organisational failure disguised as a
technical decision.

The question is not "TypeScript or Python". It is **where the seam goes**.

## Options considered

**Rewrite in TypeScript.** One runtime, one deploy. Rejected: it moves ownership of the
statistical logic away from the people qualified to own it, and the TS numerical ecosystem is
not a substitute.

**Embed Python in Node** (PyO3-style bridges, `python-shell`, WASM). Rejected: shared process
lifecycle, shared memory pressure, a GIL inside the event loop, and crash coupling — a
segfault in a native extension takes down the control plane. Debugging spans two runtimes with
no clean boundary. This is the option that looks cheapest and ages worst.

**Subprocess with JSON over stdin/stdout.** Cheap and honest, and effectively what stdio-MCP
is — but bespoke: no schema, no discovery, no auth story, no reuse from any other client, and
a hand-rolled framing protocol that someone will have to maintain.

**Separate service behind MCP.** Chosen.

## Decision

`services/segment-py` is a **standalone Python 3.12 process** exposing MCP tools over
Streamable HTTP. The control plane calls it exactly the way it calls the CRM or the ESP —
`guardedCall(ctx, runId, stepId, 'segment-py', 'segment.score_segment', args)` — through the
same policy gateway, with the same audit trail.

The point being demonstrated: **MCP is a contract between runtimes, not a library**. Once the
integration boundary is a protocol (ADR-003), the language on the other side stops being an
architectural concern. Adding a Go service or a Java service tomorrow changes nothing in the
control plane.

Structure inside the service mirrors the same discipline: `scoring.py` holds pure functions
with no I/O and carries the unit tests; `server.py` is a thin MCP adapter. The tests never
start a server.

## Consequences

**Positive**

- Data logic stays in the language and toolchain of the people who own it, and it is unit
  tested there.
- Independent deploy, independent scaling, independent failure. A hung scoring call is a
  timeout, not a control-plane outage.
- The Python agent is subject to identical policy and audit treatment — polyglot does not mean
  a hole in the permission model. This is the part that matters and the part that ad-hoc
  subprocess integrations always miss.
- Proves the architecture generalises. A reviewer can extrapolate to any stack.

**Negative**

- More operational surface: a second image, a second dependency set, a second health check,
  a second thing to keep patched.
- Network hop and serialization on every call; large customer lists must be passed by
  reference (segment id) rather than by value at real volume. The POC passes small lists
  inline and this limit is recorded in `SCALE-LIMITS.md`.
- Two test toolchains in CI (`vitest` and `pytest`).
- Distributed tracing must cross the boundary explicitly — `run_id` and `tenant_id` are passed
  as tool arguments and re-emitted as span attributes on the Python side.

**Deliberately not done in the POC:** authentication on the Python service. It listens on the
internal network and is reachable only by the control plane. In production it would carry the
same OAuth resource-server treatment as the other MCP servers; this is listed explicitly in
the README's "what is mocked" section rather than glossed over.
