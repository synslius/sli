# Proof B — triage-cluster (real-task verified FLAG)

A real-task proof that the SLI carries **verification for a FLAG**, not only a
PASS (spec
[`docs/specs/2026-06-04-sli-heart-slice0-design.md`](../../docs/specs/2026-06-04-sli-heart-slice0-design.md)
§5, Proof B). A worker emits a **FLAG** claim (it carries a probe — the triage is
a *finding*, not a finished PASS) with two observed pointers into self-contained
bundled fixtures. S3a reproduces both; the stub judge entails the finding;
`evidence_verified:true` → a **verified finding**: `verdict_adjudicated:FLAG`,
`evidence_verified:true`, `authoritative:false`, routed to the findings filter.

## Run

```bash
bun examples/triage-cluster/run.ts            # run + print outcome
bun examples/triage-cluster/run.ts --write    # ALSO regenerate the locked receipt
```

Locked receipt: `proof-b.receipt.json`.

## The finding

> *The ISO-8601 override slot is disabled, so the dual-format default prompt is
> in force.*

| Pointer | Fixture | `mustMatch` | Role |
|---------|---------|-------------|------|
| load-bearing | `src/everos/config/prompt_slots/episode_extract.yaml` | `^enabled:\s*false` (regex, multiline) | anchored to the **operative key** — a comment mentioning "disabled" cannot satisfy it (round-3 P3) |
| corroborating | `src/everos/everalgo/prompts/time_handling.txt` | `IMPORTANT TIME HANDLING` (substring) | the dual-format TIME block the vendored default emits |

Both reproduce; the quorum entails; `evidence_verified:true`. A FLAG is **never**
authoritative — even a fully-verified one — so it goes to the findings queue,
never the authoritative action path.

## Determinism contract (the proof's honesty)

This proof runs **green in clean CI** and produces a **byte-identical** receipt
(`ts` excluded), because:

- **(a) The worker FLAG claim is constructed in-fixture** — no real worker LLM.
- **(b) S3a runs against [`./fixtures`](./fixtures)** (self-contained). The
  fixtures are **copies** of real-world snippets; the real-world source paths are
  noted below for provenance, but the proof does **not** depend on them.
- **(c) The relevance judge is a deterministic stub** returning the
  fixture-correct verdict — it locks the wiring + the code-derivation, not an
  LLM's mood.

### Real-world source (provenance only — NOT a runtime dependency)

The bundled fixtures are copies of slices from the EverOS arsenal:

- `src/everos/config/prompt_slots/episode_extract.yaml` — the ISO-8601 override
  prompt slot (operative key `enabled: false`).
- the vendored everalgo time-handling prompt (the dual-format TIME block).

In the real codebase the disabled slot makes the loader yield `prompt=None` → the
vendored everalgo default (dual format) is in force. The proof reproduces the
**operative shape** of that finding from the bundled copies; it does not reach
into the arsenal.
