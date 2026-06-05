// tests/proofwheel.test.ts — Phase 3 (S4 code-derived evidence_verified)

import { describe, expect, test } from "bun:test";
import { buildProofWheel, deriveEvidenceVerified } from "../src/proofwheel.ts";
import type { Adjudication } from "ablesyn";

function adj(over: Partial<Adjudication> = {}): Adjudication {
  return {
    claim_id: "c",
    verdict_claimed: "PASS",
    verdict_adjudicated: "PASS_UNVERIFIED",
    rules_fired: [],
    ok: true,
    hard_structural: false,
    ...over,
  };
}

const rec = (reproduced: boolean, reachable: boolean) => ({
  item_ref: "e0",
  record: { reproduced, reachable, detail: {} },
});

describe("deriveEvidenceVerified — code-derived keystone (spec §4.3)", () => {
  test("S3 not run → null", () => {
    expect(deriveEvidenceVerified(false, [], null)).toBeNull();
  });
  test("any unreachable → false", () => {
    expect(deriveEvidenceVerified(true, [rec(true, false)], true)).toBe(false);
  });
  test("any not-reproduced → false", () => {
    expect(deriveEvidenceVerified(true, [rec(false, true)], true)).toBe(false);
  });
  test("relevance quorum not true → false", () => {
    expect(deriveEvidenceVerified(true, [rec(true, true)], false)).toBe(false);
    expect(deriveEvidenceVerified(true, [rec(true, true)], null)).toBe(false);
  });
  test("all reproduced + reachable + quorum true → true", () => {
    expect(deriveEvidenceVerified(true, [rec(true, true)], true)).toBe(true);
  });
});

describe("deriveEvidenceVerified — VACUOUS-PASS GUARD (Wave-3 review foot-gun)", () => {
  const advisoryRec = (reproduced: boolean, reachable: boolean) => ({
    item_ref: "e0",
    record: { reproduced, reachable, detail: {} },
    critical: false as const,
  });

  test("S3 ran but EMPTY reproduction set + quorum true → null (NOT true)", () => {
    // Empty critical set: every ∀ check is vacuously satisfied, quorum is
    // vacuously unanimous. The naive derivation would return true from ZERO
    // evidence. The guard returns null instead.
    expect(deriveEvidenceVerified(true, [], true)).toBeNull();
  });

  test("S3 ran but ALL items advisory (caller policy) + quorum true → null (NOT true)", () => {
    // A caller policy marked the only reproduced/reachable item advisory. There
    // is no CRITICAL evidence to verify → evidence_verified must be null.
    expect(deriveEvidenceVerified(true, [advisoryRec(true, true)], true)).toBeNull();
  });

  test("guard returns NULL (not false) so PASS stays PASS_UNVERIFIED, never promoted from nothing", () => {
    const w = buildProofWheel({
      wave_key: "wave_0",
      adjudication: adj({ ok: true }),
      claim_json: { id: "c" },
      assertion: "x",
      layer: "BEHAVIOR",
      s3Ran: true,
      reproduction: [advisoryRec(true, true)], // only advisory evidence
      relevanceQuorum: true, // vacuously unanimous over zero critical items
      ts: null,
    });
    expect(w.evidence_verified).toBeNull();
    expect(w.verdict_adjudicated).toBe("PASS_UNVERIFIED"); // NOT promoted to PASS
    expect(w.authoritative).toBe(false);
  });

  test("a single CRITICAL reproduced item still verifies (guard does not over-fire)", () => {
    // Sanity: the guard only fires on an EMPTY critical set. One critical green
    // item alongside advisory ones still derives true.
    const mixed = [
      { item_ref: "e0", record: { reproduced: true, reachable: true, detail: {} }, critical: true as const },
      advisoryRec(false, false), // advisory + unreachable does not fail the gate
    ];
    expect(deriveEvidenceVerified(true, mixed, true)).toBe(true);
  });
});

describe("buildProofWheel — structural path (Wave 2)", () => {
  test("PASS_UNVERIFIED with S3 off → evidence_verified null, not authoritative", () => {
    const w = buildProofWheel({
      wave_key: "wave_0",
      adjudication: adj(),
      claim_json: { id: "c" },
      assertion: "x",
      layer: "BEHAVIOR",
      s3Ran: false,
      ts: null,
    });
    expect(w.evidence_verified).toBeNull();
    expect(w.verdict_adjudicated).toBe("PASS_UNVERIFIED");
    expect(w.authoritative).toBe(false);
  });

  test("ts:null is deterministic (excluded-field stays null)", () => {
    const mk = () =>
      buildProofWheel({
        wave_key: "wave_0",
        adjudication: adj(),
        claim_json: { id: "c" },
        assertion: "x",
        layer: "BEHAVIOR",
        s3Ran: false,
        ts: null,
      });
    expect(JSON.stringify(mk())).toBe(JSON.stringify(mk()));
  });
});

describe("buildProofWheel — invariant: relevance cannot self-upgrade an unreproduced item", () => {
  test("reproduced:false + quorum true → evidence_verified false, never authoritative", () => {
    const w = buildProofWheel({
      wave_key: "wave_0",
      adjudication: adj(),
      claim_json: { id: "c" },
      assertion: "x",
      layer: "BEHAVIOR",
      s3Ran: true,
      reproduction: [rec(false, true)],
      relevanceQuorum: true, // judge says relevant, but it was not reproduced
      ts: null,
    });
    expect(w.evidence_verified).toBe(false);
    expect(w.authoritative).toBe(false);
    expect(w.verdict_adjudicated).toBe("PASS_UNVERIFIED"); // NOT promoted to PASS
  });

  test("ok:false can never be evidence_verified:true (throws if code violates it)", () => {
    expect(() =>
      buildProofWheel({
        wave_key: "wave_0",
        adjudication: adj({ ok: false }),
        claim_json: { id: "c" },
        assertion: "x",
        layer: "BEHAVIOR",
        s3Ran: true,
        reproduction: [rec(true, true)],
        relevanceQuorum: true,
        ts: null,
      }),
    ).toThrow(/invariant violated/);
  });
});

describe("buildProofWheel — full S3 green promotes PASS_UNVERIFIED → authoritative PASS", () => {
  test("all green → verdict PASS, authoritative true", () => {
    const w = buildProofWheel({
      wave_key: "wave_0",
      adjudication: adj({ ok: true }),
      claim_json: { id: "c" },
      assertion: "dist/cli.js exists and is the built CLI entry",
      layer: "BEHAVIOR",
      s3Ran: true,
      reproduction: [rec(true, true)],
      relevanceQuorum: true,
      ts: null,
    });
    expect(w.evidence_verified).toBe(true);
    expect(w.verdict_adjudicated).toBe("PASS");
    expect(w.authoritative).toBe(true);
  });
});
