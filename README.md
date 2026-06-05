# sli — Self-evidencing Layer Interface (Slice 0)

A harness-native **anti-LGTM evidence gate** for multi-agent workflows. Workers
emit ABLE claims (a verdict + evidence); a **structural tier** (the
[`ablesyn`](https://github.com/synslius/ablesyn) checker) catches crude cheats; a
**semantic tier** (a deterministic reproducer + an independent relevance quorum)
catches fabricated evidence. The authority field — `evidence_verified` — is
**derived by code**, never by a single agent's say-so. Only an `evidence_verified`
PASS is authoritative.

> A fake or unsupported PASS can never become authoritative.

## Why

LLM agents report success in one layer while being judged in another. SLI makes
the split mechanical: a claim's verdict is adjudicated against an evidence
contract, and a PASS is trusted only when its cited evidence **reproduces from
source** *and* an **independent quorum** judges it relevant to the claim's
assertion (entailment, not lexical overlap).

## Architecture (Slice 0)

| Module | Role |
| --- | --- |
| `src/pointer.ts` | Typed `EvidencePointer` (file / sandboxed read-only command) + the deterministic **S3a reproducer** (a machine record, no conclusion). |
| `src/sliWave.ts` | The dependency-injected wave orchestrator: workers → structural adjudicate (`ablesyn`) → semantic reproduce + relevance quorum → code-derived receipt. Fail-closed (missing/duplicate/throw → BLOCK). |
| `src/relevance.ts` | The independent **relevance quorum** — entailment-not-overlap rubric, injection-proof, judge provenance, gate-only (can never self-upgrade authority). |
| `src/proofwheel.ts` | The **ProofWheel** receipt. `evidence_verified` and `authoritative` are pure code over `{reproduction ∧ quorum}` (over *critical* items only), with a hard invariant: a structurally-invalid (`ok:false`) claim can never be `evidence_verified`. |
| `src/adjudicate.mjs` | A thin JSON bridge over `ablesyn`-as-library (for workflow-embedded use). |

Depends on [`ablesyn`](https://github.com/synslius/ablesyn) as a sibling package
(clone it alongside this repo, or use the published version once available).

## The proofs (self-evidencing regression guards)

`examples/` ships 5 runnable proofs with **locked, deterministic receipts**:

- **A** — four crude cheats (empty / admits-missing / inferred-only /
  motivation-as-proof) are downgraded to FLAG by the structural tier alone.
- **A′** — a fabricated PASS citing an **absent** artifact is caught (reproduction fails).
- **A″** — a fabricated PASS citing a **real-but-unrelated** artifact is caught
  *only* by the semantic tier (it reproduces, but fails the relevance quorum).
- **A‴** — an **honest** PASS reproduces and entails → `authoritative: true`
  (the central output is reachable, not just cheats caught).
- **B** — a real-task finding becomes a **verified FLAG** (evidence reproduced,
  routed to the findings queue).

If a future change ever lets a cheat through, the matching proof fails loudly.

## Run

```bash
bun install
bun test        # deterministic; run-twice byte-identical
```

## License

Apache-2.0.
