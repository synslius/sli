// examples/triage-cluster/proofs.ts — Proof B (real-task verified FLAG)
//
// The triage-cluster proof (spec §5). A worker emits a FLAG claim (it carries a
// probe — the triage is not finished, it is a FINDING) with observed pointers to
// SELF-CONTAINED bundled fixtures:
//   - load-bearing: a copy of an episode_extract.yaml snippet containing
//     'enabled: false'. The mustMatch is an anchored regex (^enabled:\s*false,
//     multiline) bound to the OPERATIVE key — a comment merely mentioning
//     "disabled" cannot satisfy it (round-3 P3).
//   - corroborating: the dual-format TIME block fixture, content-matched
//     ("IMPORTANT TIME HANDLING").
// S3a reproduces BOTH; the stub judge returns relevant:true → evidence_verified:
// true → a VERIFIED FINDING: verdict FLAG, evidence_verified:true,
// authoritative:false (a FLAG never authorizes action), routed to the findings
// filter.
//
// DETERMINISM CONTRACT (same as adversarial-catch/proofs.ts):
//   (a) the worker FLAG claim is CONSTRUCTED in-fixture (no real worker LLM);
//   (b) S3a runs against ./fixtures (self-contained — the real-world source path
//       is noted in the README but NOT depended upon);
//   (c) the relevance judge is a DETERMINISTIC STUB returning the
//       fixture-correct verdict (locks the wiring + derivation, not an LLM mood).
//
// `ts` is forced to null on the receipt (deterministic; excluded from equality).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { sliWave, type Dispatch, type SliWaveOptions } from "../../src/sliWave.ts";
import type { ProofWheel } from "../../src/proofwheel.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Self-contained fixture root — the sliWave S3a reproducer sandbox. */
export const FIXTURE_ROOT = realpathSync(join(HERE, "fixtures"));

function fakeWorker(map: Record<string, unknown>): Dispatch {
  return async (prompt) => map[prompt];
}
const work = (item: string) => item;

// Deterministic STUB judge: it entails the disabled-slot finding. It inspects
// the reproducer DATA block only (anti-echo). The bundled fixtures both entail
// "the ISO-8601 override slot is disabled, so the dual-format default is in
// force": the yaml carries the disabled operative key, the time_handling fixture
// carries the dual-format TIME block.
const stubTriageJudge: Dispatch = async (prompt) => {
  const aboutDisabledSlot =
    prompt.includes("enabled:") ||
    prompt.includes("episode_extract.yaml") ||
    prompt.includes("IMPORTANT TIME HANDLING") ||
    prompt.includes("time_handling.txt");
  return { relevant: aboutDisabledSlot };
};

// ===========================================================================
// PROOF B claim — a FLAG (carries a probe) with two observed pointers.
// ===========================================================================

export const PROOF_B_CLAIM = {
  id: "triage_iso8601_disabled",
  layer: "BEHAVIOR",
  assertion:
    "the ISO-8601 override slot is disabled, so the dual-format default prompt is in force",
  evidence: [
    {
      kind: "observed",
      args: ["episode_extract.yaml shows enabled: false on the operative key"],
      pointer: {
        type: "file",
        path: "src/everos/config/prompt_slots/episode_extract.yaml",
        // Anchored to the OPERATIVE key (multiline) — not a comment mentioning
        // "disabled" (round-3 P3).
        mustMatch: { kind: "regex", value: "^enabled:\\s*false", flags: "m" },
      },
    },
    {
      kind: "observed",
      args: ["the vendored everalgo default carries the dual-format TIME block"],
      pointer: {
        type: "file",
        path: "src/everos/everalgo/prompts/time_handling.txt",
        mustMatch: { kind: "substring", value: "IMPORTANT TIME HANDLING" },
      },
    },
  ],
  // A FLAG carries a probe — the triage is a FINDING, not a finished PASS.
  probe: { next: ["confirm no other slot re-enables the override downstream"] },
  verdict: { status: "FLAG", reasons: ["override slot disabled; dual-format default active"] },
};

export function proofBOpts(): SliWaveOptions<string> {
  return {
    work,
    ableSchema: { type: "object" },
    dispatch: fakeWorker({ triage_iso8601_disabled: PROOF_B_CLAIM }),
    verifyEvidence: true,
    repoRoot: FIXTURE_ROOT,
    relevanceDispatch: stubTriageJudge,
    relevanceQuorum: 2,
  };
}

export async function runProofB(): Promise<ProofWheel> {
  const res = await sliWave(["triage_iso8601_disabled"], proofBOpts());
  return res[0]!.receipt;
}

/**
 * The findings-filter predicate: a VERIFIED FINDING is a non-hard-structural
 * FLAG whose evidence reproduced + entailed. This is the routing decision Proof
 * B locks — a verified FLAG goes to the findings queue, NOT the authoritative
 * action path (it is never `authoritative`).
 */
export function isVerifiedFinding(r: ProofWheel): boolean {
  return r.verdict_adjudicated === "FLAG" && !r.hard_structural && r.evidence_verified === true;
}
