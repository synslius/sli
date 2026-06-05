// tests/proofs.test.ts — Phase 5 (Wave 4): the 5 proofs as PERMANENT REGRESSION GUARDS.
//
// Each proof RE-RUNS its runnable harness (the same code examples/.../run.ts
// executes) and asserts:
//   (1) the claimed OUTCOME (verdict / evidence_verified / authoritative / …), and
//   (2) BYTE-EQUALITY with the locked receipt fixture on disk (ts excluded).
//
// The adversarial proofs (A, A′, A″) are anti-cheat guards: if a future change
// lets a cheat through, the outcome assertion fails LOUDLY here. A‴ proves the
// authoritative PASS is REACHABLE (the central output exists). B proves a FLAG
// can be a VERIFIED FINDING (verification is carried for both polarities).
//
// DETERMINISM: receipts are compared with `ts` excluded (normalized to null).
// The proofs use only in-fixture planted claims + self-contained bundled
// fixtures + a deterministic stub judge — no LLM, no clock, no RNG in any
// compared field (spec §6 invariant 5).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runProofA,
  runProofAPrime,
  runProofADoublePrime,
  runProofATriplePrime,
} from "../examples/adversarial-catch/proofs.ts";
import { runProofB, isVerifiedFinding } from "../examples/triage-cluster/proofs.ts";
import { lock } from "../examples/lockReceipt.ts";
import type { ProofWheel } from "../src/proofwheel.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADV = join(ROOT, "examples", "adversarial-catch");
const TRI = join(ROOT, "examples", "triage-cluster");

function readReceipt(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Normalize a live receipt to its locked form (ts → null) for equality. */
function locked(r: ProofWheel): unknown {
  return JSON.parse(JSON.stringify(lock(r)));
}

// ===========================================================================
// PROOF A — structural (verifyEvidence:false): 5 planted claims.
// The 4 cheats → FLAG (non-authoritative); the honest → PASS_UNVERIFIED,
// evidence_verified:null, authoritative:false. (No S3.)
// ===========================================================================

describe("Proof A — structural cheat-catch (4 cheats FLAG, 1 honest PASS_UNVERIFIED)", () => {
  test("outcome: the 4 cheats each downgrade to FLAG, non-authoritative", async () => {
    const a = await runProofA();
    const byId = Object.fromEntries(a.map((r) => [r.claim_id, r]));

    for (const cheat of ["empty_evidence", "admits_missing", "inferred_only", "motivation_as_proof"]) {
      const r = byId[cheat]!;
      expect(r.verdict_adjudicated).toBe("FLAG");
      expect(r.authoritative).toBe(false);
      // No S3 ran → evidence_verified is null for the whole wave.
      expect(r.evidence_verified).toBeNull();
      // None of the cheats is hard-structural — they are soft FLAGs (eligible),
      // exactly per spec §4.1 (an empty-evidence PASS must FLAG, not BLOCK).
      expect(r.hard_structural).toBe(false);
    }
  });

  test("outcome: the honest observed PASS → PASS_UNVERIFIED, ev null, not authoritative", async () => {
    const a = await runProofA();
    const honest = a.find((r) => r.claim_id === "honest_observed")!;
    expect(honest.verdict_adjudicated).toBe("PASS_UNVERIFIED");
    expect(honest.evidence_verified).toBeNull();
    expect(honest.authoritative).toBe(false);
  });

  test("LOCKED RECEIPT: the wave matches proof-a.receipt.json byte-for-byte (ts excluded)", async () => {
    const a = await runProofA();
    const live = a.map((r) => locked(r));
    const fixture = readReceipt(join(ADV, "proof-a.receipt.json")) as unknown[];
    expect(live).toEqual(fixture);
  });
});

// ===========================================================================
// PROOF A′ — fabricated-ABSENT. reproduced:false → evidence_verified:false →
// authoritative:false. Judges scream relevant:true → the catch is STRUCTURAL.
// ===========================================================================

describe("Proof A′ — fabricated-absent (non-existent path → not authoritative)", () => {
  test("outcome: reproduced:false, evidence_verified:false, authoritative:false", async () => {
    const r = await runProofAPrime();
    expect(r.reproduction[0]!.reproduced).toBe(false);
    expect(r.reproduction[0]!.reachable).toBe(false);
    expect(r.reproduction[0]!.critical).toBe(true);
    expect(r.evidence_verified).toBe(false);
    expect(r.authoritative).toBe(false);
    // Never promoted, even though the judge said relevant:true.
    expect(r.verdict_adjudicated).toBe("PASS_UNVERIFIED");
  });

  test("LOCKED RECEIPT: matches proof-a-prime.receipt.json (ts excluded)", async () => {
    const r = await runProofAPrime();
    expect(locked(r)).toEqual(readReceipt(join(ADV, "proof-a-prime.receipt.json")));
  });
});

// ===========================================================================
// PROOF A″ — fabricated-PRESENT-BUT-UNRELATED. reproduced:true (real file,
// mustMatch present) but quorum:false (criterion does not ENTAIL) → ev:false.
// The proof the structural tier alone cannot provide.
// ===========================================================================

describe("Proof A″ — present-but-unrelated (S3a true, S3b false → not authoritative)", () => {
  test("outcome: reproduced:true, relevance_quorum:false, evidence_verified:false", async () => {
    const r = await runProofADoublePrime();
    expect(r.reproduction[0]!.reproduced).toBe(true); // the file EXISTS, mustMatch present
    expect(r.reproduction[0]!.reachable).toBe(true);
    expect(r.relevance_quorum).toBe(false); // but it does not ENTAIL the assertion
    expect(r.evidence_verified).toBe(false);
    expect(r.authoritative).toBe(false);
    expect(r.verdict_adjudicated).toBe("PASS_UNVERIFIED");
    // Provenance shows the judges actually ran and unanimously declined.
    expect(r.relevance_provenance!.items[0]!.judges).toHaveLength(2);
    expect(r.relevance_provenance!.items[0]!.judges.every((j) => j.relevant === false)).toBe(true);
  });

  test("LOCKED RECEIPT: matches proof-a-doubleprime.receipt.json (ts excluded)", async () => {
    const r = await runProofADoublePrime();
    expect(locked(r)).toEqual(readReceipt(join(ADV, "proof-a-doubleprime.receipt.json")));
  });
});

// ===========================================================================
// PROOF A‴ — HONEST positive. reproduced:true AND quorum:true → ev:true →
// verdict promoted to PASS → authoritative:true. The central output is REACHABLE.
// ===========================================================================

describe("Proof A‴ — honest positive (reproduces + entails → AUTHORITATIVE PASS)", () => {
  test("outcome: evidence_verified:true, verdict promoted to PASS, authoritative:true", async () => {
    const r = await runProofATriplePrime();
    expect(r.reproduction[0]!.reproduced).toBe(true);
    expect(r.reproduction[0]!.reachable).toBe(true);
    expect(r.relevance_quorum).toBe(true);
    expect(r.evidence_verified).toBe(true);
    expect(r.verdict_adjudicated).toBe("PASS"); // promoted from PASS_UNVERIFIED
    expect(r.authoritative).toBe(true);
  });

  test("LOCKED RECEIPT: matches proof-a-tripleprime.receipt.json (ts excluded)", async () => {
    const r = await runProofATriplePrime();
    expect(locked(r)).toEqual(readReceipt(join(ADV, "proof-a-tripleprime.receipt.json")));
  });
});

// ===========================================================================
// PROOF B — real-task verified FLAG. Both pointers reproduce; quorum:true →
// evidence_verified:true → a VERIFIED FINDING (FLAG, NOT authoritative), routed
// to the findings filter.
// ===========================================================================

describe("Proof B — real-task verified FLAG (verified finding, not authoritative)", () => {
  test("outcome: both pointers reproduce, quorum:true, evidence_verified:true, FLAG, not authoritative", async () => {
    const r = await runProofB();
    expect(r.verdict_adjudicated).toBe("FLAG");
    expect(r.reproduction).toHaveLength(2);
    expect(r.reproduction.every((x) => x.reproduced === true && x.reachable === true)).toBe(true);
    expect(r.relevance_quorum).toBe(true);
    expect(r.evidence_verified).toBe(true);
    // A FLAG is NEVER authoritative — even a fully-verified one.
    expect(r.authoritative).toBe(false);
    // It qualifies for the verified-findings queue.
    expect(isVerifiedFinding(r)).toBe(true);
  });

  test("LOCKED RECEIPT: matches proof-b.receipt.json (ts excluded)", async () => {
    const r = await runProofB();
    expect(locked(r)).toEqual(readReceipt(join(TRI, "proof-b.receipt.json")));
  });
});

// ===========================================================================
// Cross-proof determinism — every proof is byte-identical run-to-run (ex-ts).
// ===========================================================================

describe("determinism — all 5 proofs are run-to-run byte-identical (ts excluded)", () => {
  test("re-running each proof yields the same locked receipt", async () => {
    const pairs: [unknown, unknown][] = [
      [(await runProofA()).map(locked), (await runProofA()).map(locked)],
      [locked(await runProofAPrime()), locked(await runProofAPrime())],
      [locked(await runProofADoublePrime()), locked(await runProofADoublePrime())],
      [locked(await runProofATriplePrime()), locked(await runProofATriplePrime())],
      [locked(await runProofB()), locked(await runProofB())],
    ];
    for (const [a, b] of pairs) {
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});
