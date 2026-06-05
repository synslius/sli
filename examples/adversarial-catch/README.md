# Proof A / A′ / A″ / A‴ — adversarial-catch

The four adversarial proofs for the SLI heart (spec
[`docs/specs/2026-06-04-sli-heart-slice0-design.md`](../../docs/specs/2026-06-04-sli-heart-slice0-design.md)
§5). Each runs the **real** `sliWave` pipeline (S1→S2→S3a→S3b→S4) and locks its
outcome into a receipt fixture (`ts` excluded). The cheat proofs are **permanent
regression guards**: if a future change lets a cheat through, the assertion in
[`tests/proofs.test.ts`](../../tests/proofs.test.ts) fails loudly.

## Run

```bash
bun examples/adversarial-catch/run.ts            # run + print outcomes
bun examples/adversarial-catch/run.ts --write    # ALSO regenerate the locked receipts
```

## The proofs

| Proof | verifyEvidence | Planted shape | Outcome |
|-------|----------------|---------------|---------|
| **A** | `false` | wave of 5: empty-evidence / admits-missing / inferred-only / motivation-as-proof (`frame.effects:[{kind:"raise_truth_confidence"}]`) / honest observed | 4 cheats → `verdict_adjudicated:FLAG` (non-authoritative); honest → `PASS_UNVERIFIED`, `evidence_verified:null`, `authoritative:false` |
| **A′** | `true` | honest-looking PASS, file pointer at a **non-existent** path | S3a `reproduced:false` → `evidence_verified:false` → `authoritative:false` |
| **A″** | `true` | PASS pointing at a **real** bundled fixture that EXISTS with `mustMatch` present (`reproduced:true`), but the criterion does **not entail** the assertion | stub judge `relevant:false` → quorum `false` → `evidence_verified:false` → `authoritative:false` — *the proof the structural tier alone cannot provide* |
| **A‴** | `true` | honest PASS whose pointer reproduces **and** entails | quorum `true` → `evidence_verified:true` → verdict promoted to `PASS` → `authoritative:true` — proves the central output is **reachable** |

Locked receipts: `proof-a.receipt.json` (the 5-row wave), `proof-a-prime.receipt.json`,
`proof-a-doubleprime.receipt.json`, `proof-a-tripleprime.receipt.json`.

## Determinism contract (the proof's honesty)

These proofs run **green in clean CI** and produce **byte-identical** receipts
(`ts` excluded), because:

- **(a) Worker claims are constructed in-fixture.** There is **no real worker
  LLM** — we are *planting* specific cheat/honest claim shapes. The fake
  `dispatch` returns the canned claim for each item.
- **(b) S3a reproduction is self-contained.** The reproducer resolves file
  pointers under [`./fixtures`](./fixtures) (the `sliWave` `repoRoot`) — never an
  external path (e.g. the EverOS arsenal). A′ points at a path that simply does
  not exist under that root; A″/A‴ point at the bundled `dist/cli.js` /
  `dist/notes.txt`.
- **(c) The relevance judge is a deterministic stub.** It returns the
  fixture-correct verdict by inspecting only the reproducer **data block**
  (anti-echo: it never sees worker prose). The real LLM judge is a runtime /
  Slice-1 concern — these proofs lock the **wiring + the code-derivation**, not an
  LLM's mood.

`A′` is caught even when the stub judge screams `relevant:true` — proving the
catch is **structural** (`reproduced:false`), not the judge merely declining.
