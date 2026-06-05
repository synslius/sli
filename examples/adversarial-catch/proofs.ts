// examples/adversarial-catch/proofs.ts — Proof A / A′ / A″ / A‴
//
// The adversarial-catch proof bundle (spec §5). Each proof is a PURE, DETERMINISTIC
// function: it plants a specific worker-claim shape, runs the REAL sliWave
// pipeline (S1→S2→S3a→S3b→S4), and returns the receipt + the asserted outcome.
//
// DETERMINISM CONTRACT (read this — it is the proof's load-bearing honesty):
//   (a) Worker ABLE claims are CONSTRUCTED in-fixture. There is NO real worker
//       LLM: we are PLANTING specific cheat/honest shapes. The fake `dispatch`
//       returns the canned claim for each item.
//   (b) S3a reproduction runs against SELF-CONTAINED fixture files bundled in
//       ./fixtures (resolved as the sliWave repoRoot). It does NOT depend on any
//       external path (e.g. the EverOS arsenal). A′ points at a path that does
//       not exist UNDER that fixture root.
//   (c) The relevance judge is a DETERMINISTIC STUB dispatch returning the
//       fixture-correct verdict. The real LLM judge is a runtime / Slice-1
//       concern — this proof locks the WIRING + the code-derivation, not an
//       LLM's mood. The stub decides entailment from the reproducer DATA block
//       only (anti-echo: it never sees worker prose).
//
// `ts` is forced to null on every receipt (deterministic; excluded from the
// locked-receipt equality check).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { sliWave, type Dispatch, type SliWaveOptions } from "../../src/sliWave.ts";
import type { ProofWheel } from "../../src/proofwheel.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Self-contained fixture root — the sliWave S3a reproducer sandbox. */
export const FIXTURE_ROOT = realpathSync(join(HERE, "fixtures"));

// ---------------------------------------------------------------------------
// Fake WORKER dispatch — returns the planted claim for an item key.
// ---------------------------------------------------------------------------

function fakeWorker(map: Record<string, unknown>): Dispatch {
  return async (prompt) => map[prompt];
}
const work = (item: string) => item;

// ---------------------------------------------------------------------------
// Deterministic STUB relevance judge.
//
// It inspects the reproducer DATA block (assertion + pointer + criterion +
// reproducer detail — serialized into the judge prompt by relevance.ts). It is
// anti-echo by construction: it NEVER sees the worker's verdict.reasons /
// belief.notes (relevance.ts does not forward them). It decides entailment for
// the bundled fixtures:
//   - the cli.js shebang pointer ENTAILS "built CLI entry"        → relevant:true
//   - the notes.txt "groceries" pointer does NOT entail it        → relevant:false
// ---------------------------------------------------------------------------

const stubEntailmentJudge: Dispatch = async (prompt) => {
  // "groceries" is the present-but-unrelated A″ fixture: a real file, mustMatch
  // present (reproduced:true), but it does not ENTAIL the CLI-entry assertion.
  const aboutGroceries = prompt.includes("groceries");
  // The cli.js shebang DOES entail the CLI-entry assertion.
  const aboutCliEntry = prompt.includes("#!/usr/bin/env node") || prompt.includes("cli.js");
  return { relevant: aboutCliEntry && !aboutGroceries };
};

/** A judge that screams relevant:true regardless — used to prove A′ is caught
 * STRUCTURALLY (reproduced:false), NOT merely by the judge declining. */
const stubAlwaysRelevant: Dispatch = async () => ({ relevant: true });

function verifyOpts(judge: Dispatch, claims: Record<string, unknown>): SliWaveOptions<string> {
  return {
    work,
    ableSchema: { type: "object" },
    dispatch: fakeWorker(claims),
    verifyEvidence: true,
    repoRoot: FIXTURE_ROOT,
    relevanceDispatch: judge,
    relevanceQuorum: 2,
  };
}

// ===========================================================================
// PROOF A — structural (verifyEvidence:false). A wave of 5 PLANTED claims.
//
// The 4 cheats must each downgrade to FLAG (non-authoritative). The honest
// observed PASS must survive as PASS_UNVERIFIED with evidence_verified:null and
// authoritative:false (S3 did not run). No S3 in this proof.
// ===========================================================================

export const PROOF_A_CLAIMS: Record<string, unknown> = {
  // 1. empty-evidence PASS → PASS_WITHOUT_EVIDENCE (error) → FLAG.
  empty_evidence: {
    id: "empty_evidence",
    layer: "BEHAVIOR",
    assertion: "the timestamp migration is complete",
    evidence: [],
    verdict: { status: "PASS" },
  },
  // 2. admits-missing PASS → PASS_WITH_MISSING_EVIDENCE + PASS_WITHOUT_EVIDENCE → FLAG.
  admits_missing: {
    id: "admits_missing",
    layer: "BEHAVIOR",
    assertion: "the timestamp migration is complete",
    evidence: [{ kind: "missing", args: ["never actually checked the config"] }],
    verdict: { status: "PASS" },
  },
  // 3. inferred-only PASS → PASS_WITHOUT_OBSERVED_EVIDENCE (downgrade) → FLAG.
  inferred_only: {
    id: "inferred_only",
    layer: "BEHAVIOR",
    assertion: "the timestamp migration is complete",
    evidence: [{ kind: "inferred", args: ["it should be done by now"] }],
    verdict: { status: "PASS" },
  },
  // 4. motivation-as-proof PASS → MOTIVATION_RAISES_TRUTH_CONFIDENCE (error) → FLAG.
  //    Has observed evidence so the ONLY downgrade is the illegal truth-confidence
  //    frame effect — a worker trying to "frame" its way to a PASS.
  motivation_as_proof: {
    id: "motivation_as_proof",
    layer: "BEHAVIOR",
    assertion: "the timestamp migration is complete",
    evidence: [{ kind: "observed", args: ["glanced at the dashboard"] }],
    frame: { effects: [{ kind: "raise_truth_confidence" }] },
    verdict: { status: "PASS" },
  },
  // 5. honest observed PASS → structurally clean → PASS_UNVERIFIED.
  honest_observed: {
    id: "honest_observed",
    layer: "BEHAVIOR",
    assertion: "the timestamp migration is complete",
    evidence: [{ kind: "observed", args: ["ran the migration and saw it finish"] }],
    verdict: { status: "PASS" },
  },
};

const PROOF_A_ORDER = [
  "empty_evidence",
  "admits_missing",
  "inferred_only",
  "motivation_as_proof",
  "honest_observed",
] as const;

export async function runProofA(): Promise<ProofWheel[]> {
  const results = await sliWave([...PROOF_A_ORDER], {
    work,
    ableSchema: { type: "object" },
    dispatch: fakeWorker(PROOF_A_CLAIMS),
    verifyEvidence: false, // STRUCTURAL tier only — no S3.
  });
  return results.map((r) => r.receipt);
}

// ===========================================================================
// PROOF A′ — verifyEvidence:true, fabricated-ABSENT.
// An honest-LOOKING PASS whose file pointer points at a NON-EXISTENT path under
// the fixture root. S3a reproduced:false → evidence_verified:false →
// authoritative:false. Judges scream relevant:true to prove the catch is
// STRUCTURAL (the path simply isn't there), not a judge declining.
// ===========================================================================

export const PROOF_APRIME_CLAIM = {
  id: "fabricated_absent",
  layer: "BEHAVIOR",
  assertion: "dist/cli.js exists and is the built CLI entry",
  evidence: [
    {
      kind: "observed",
      args: ["I totally built it"],
      pointer: {
        type: "file",
        path: "dist/does-not-exist.js", // absent under FIXTURE_ROOT
        mustMatch: { kind: "substring", value: "#!/usr/bin/env node" },
      },
    },
  ],
  verdict: { status: "PASS" },
};

export async function runProofAPrime(): Promise<ProofWheel> {
  const res = await sliWave(["fabricated_absent"], verifyOpts(stubAlwaysRelevant, { fabricated_absent: PROOF_APRIME_CLAIM }));
  return res[0]!.receipt;
}

// ===========================================================================
// PROOF A″ — verifyEvidence:true, fabricated-PRESENT-BUT-UNRELATED.
// A PASS whose file pointer points at a REAL bundled fixture that EXISTS and
// whose mustMatch IS present (S3a reproduced:true), but the stub judge returns
// relevant:false (the criterion does not ENTAIL the assertion) → quorum false →
// evidence_verified:false → authoritative:false. This is the proof the
// STRUCTURAL tier alone cannot provide.
// ===========================================================================

export const PROOF_ADOUBLEPRIME_CLAIM = {
  id: "fabricated_present_unrelated",
  layer: "BEHAVIOR",
  assertion: "dist/cli.js exists and is the built CLI entry",
  evidence: [
    {
      kind: "observed",
      args: ["here is a file, see?"],
      pointer: {
        type: "file",
        path: "dist/notes.txt", // REAL file, mustMatch present, but UNRELATED
        mustMatch: { kind: "substring", value: "groceries" },
      },
    },
  ],
  verdict: { status: "PASS" },
};

export async function runProofADoublePrime(): Promise<ProofWheel> {
  const res = await sliWave(
    ["fabricated_present_unrelated"],
    verifyOpts(stubEntailmentJudge, { fabricated_present_unrelated: PROOF_ADOUBLEPRIME_CLAIM }),
  );
  return res[0]!.receipt;
}

// ===========================================================================
// PROOF A‴ — verifyEvidence:true, HONEST positive.
// A PASS whose pointer reproduces (real fixture, mustMatch present) AND the stub
// judge returns relevant:true → evidence_verified:true → verdict promoted to
// PASS → authoritative:true. Proves the CENTRAL OUTPUT is REACHABLE.
// ===========================================================================

export const PROOF_ATRIPLEPRIME_CLAIM = {
  id: "honest_positive",
  layer: "BEHAVIOR",
  assertion: "dist/cli.js exists and is the built CLI entry",
  evidence: [
    {
      kind: "observed",
      args: ["saw dist/cli.js with the shebang"],
      pointer: {
        type: "file",
        path: "dist/cli.js", // REAL fixture, mustMatch present, ENTAILS the assertion
        mustMatch: { kind: "substring", value: "#!/usr/bin/env node" },
      },
    },
  ],
  verdict: { status: "PASS" },
};

export async function runProofATriplePrime(): Promise<ProofWheel> {
  const res = await sliWave(["honest_positive"], verifyOpts(stubEntailmentJudge, { honest_positive: PROOF_ATRIPLEPRIME_CLAIM }));
  return res[0]!.receipt;
}
