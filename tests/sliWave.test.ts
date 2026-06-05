// tests/sliWave.test.ts — Phase 3 (DI orchestrator with a FAKE dispatch)
//
// Injects a fake dispatch returning canned claims. Asserts S2 used adjudicate
// (mechanical, deterministic) and that wave_key association is POSITIONAL.

import { describe, expect, test } from "bun:test";
import { sliWave, type Dispatch } from "../src/sliWave.ts";

const ABLE_SCHEMA = { type: "object" }; // opaque to the standalone path

// Canned claims keyed by item.
const CLAIMS: Record<string, unknown> = {
  cleanPass: {
    id: "clean_pass",
    layer: "BEHAVIOR",
    assertion: "the built CLI entry exists",
    evidence: [{ kind: "observed", args: ["saw dist/cli.js with shebang"] }],
    verdict: { status: "PASS" },
  },
  emptyEvidencePass: {
    id: "empty_ev",
    layer: "BEHAVIOR",
    assertion: "did the thing",
    evidence: [],
    verdict: { status: "PASS" },
  },
  malformed: {
    id: "malformed",
    layer: "NOT_A_LAYER", // INVALID_LAYER → hard_structural → BLOCK
    assertion: "x",
    evidence: [{ kind: "observed", args: ["s"] }],
    verdict: { status: "PASS" },
  },
  dupA: {
    id: "same_id",
    layer: "BEHAVIOR",
    assertion: "first claim with shared id",
    evidence: [{ kind: "observed", args: ["s"] }],
    verdict: { status: "PASS" },
  },
  dupB: {
    id: "same_id",
    layer: "BEHAVIOR",
    assertion: "second claim with shared id",
    evidence: [{ kind: "observed", args: ["s"] }],
    verdict: { status: "PASS" },
  },
  undef: undefined,
};

function fakeDispatch(map: Record<string, unknown>): { dispatch: Dispatch; calls: string[] } {
  const calls: string[] = [];
  const dispatch: Dispatch = async (prompt) => {
    calls.push(prompt);
    return map[prompt];
  };
  return { dispatch, calls };
}

// work(item) just returns the item key so the fake can look up the canned claim.
const work = (item: string) => item;

describe("sliWave — fake dispatch, structural path (verifyEvidence:false)", () => {
  test("clean observed PASS → PASS_UNVERIFIED receipt, not authoritative", async () => {
    const { dispatch } = fakeDispatch(CLAIMS);
    const res = await sliWave(["cleanPass"], { work, ableSchema: ABLE_SCHEMA, dispatch });
    expect(res).toHaveLength(1);
    const r = res[0]!.receipt;
    expect(r.verdict_adjudicated).toBe("PASS_UNVERIFIED");
    expect(r.evidence_verified).toBeNull();
    expect(r.authoritative).toBe(false);
    expect(r.claim_id).toBe("clean_pass");
  });

  test("empty-evidence PASS → FLAG", async () => {
    const { dispatch } = fakeDispatch(CLAIMS);
    const res = await sliWave(["emptyEvidencePass"], { work, ableSchema: ABLE_SCHEMA, dispatch });
    const r = res[0]!.receipt;
    expect(r.verdict_adjudicated).toBe("FLAG");
    expect(r.rule_codes).toContain("PASS_WITHOUT_EVIDENCE");
    expect(r.authoritative).toBe(false);
  });

  test("malformed (INVALID_LAYER) → BLOCK, hard_structural", async () => {
    const { dispatch } = fakeDispatch(CLAIMS);
    const res = await sliWave(["malformed"], { work, ableSchema: ABLE_SCHEMA, dispatch });
    const r = res[0]!.receipt;
    expect(r.verdict_adjudicated).toBe("BLOCK");
    expect(r.hard_structural).toBe(true);
    expect(r.authoritative).toBe(false);
  });

  test("dispatch returns undefined → BLOCK (fail-closed)", async () => {
    const { dispatch } = fakeDispatch(CLAIMS);
    const res = await sliWave(["undef"], { work, ableSchema: ABLE_SCHEMA, dispatch });
    const r = res[0]!.receipt;
    expect(r.verdict_adjudicated).toBe("BLOCK");
    expect(r.hard_structural).toBe(true);
    expect(r.rule_codes).toContain("MALFORMED_CLAIM");
  });

  test("two claims with identical claim_id → at least one BLOCK, no cross-wire", async () => {
    const { dispatch } = fakeDispatch(CLAIMS);
    const res = await sliWave(["dupA", "dupB"], { work, ableSchema: ABLE_SCHEMA, dispatch });
    expect(res).toHaveLength(2);
    const blocked = res.filter((r) => r.receipt.verdict_adjudicated === "BLOCK");
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    for (const r of res) {
      if (r.receipt.verdict_adjudicated === "BLOCK") {
        expect(r.receipt.rule_codes).toContain("MALFORMED_CLAIM");
      }
    }
    // No cross-wire: each receipt's claim_json assertion matches its OWN item's
    // canned claim (positional), never the sibling's.
    expect((res[0]!.receipt.claim_json as { assertion?: string }).assertion).toBe(
      "first claim with shared id",
    );
    expect((res[1]!.receipt.claim_json as { assertion?: string }).assertion).toBe(
      "second claim with shared id",
    );
  });
});

describe("sliWave — wave_key association is POSITIONAL (never worker claim_id)", () => {
  test("wave_key is the positional index, claim_id is preserved separately", async () => {
    const { dispatch, calls } = fakeDispatch(CLAIMS);
    const res = await sliWave(["cleanPass", "emptyEvidencePass"], {
      work,
      ableSchema: ABLE_SCHEMA,
      dispatch,
    });
    expect(res[0]!.wave_key).toBe("wave_0");
    expect(res[1]!.wave_key).toBe("wave_1");
    // wave_key never equals the worker claim_id.
    expect(res[0]!.wave_key).not.toBe(res[0]!.receipt.claim_id);
    // dispatch (S1 workers) was actually invoked per item.
    expect(calls).toHaveLength(2);
  });

  test("S2 used adjudicate mechanically: same input → same receipt (determinism)", async () => {
    const { dispatch } = fakeDispatch(CLAIMS);
    const run = () =>
      sliWave(["cleanPass", "emptyEvidencePass", "malformed"], {
        work,
        ableSchema: ABLE_SCHEMA,
        dispatch,
      });
    const a = await run();
    const b = await run();
    // ts is null (deterministic standalone path), so full byte-equality holds.
    expect(JSON.stringify(a.map((r) => r.receipt))).toBe(
      JSON.stringify(b.map((r) => r.receipt)),
    );
    // Spot-check that adjudicate's verdicts are present (mechanical mapping).
    expect(a[0]!.receipt.verdict_adjudicated).toBe("PASS_UNVERIFIED");
    expect(a[1]!.receipt.verdict_adjudicated).toBe("FLAG");
    expect(a[2]!.receipt.verdict_adjudicated).toBe("BLOCK");
  });
});

describe("sliWave — authorityRequired default (fail-closed)", () => {
  test("default config never returns an authoritative PASS when verifyEvidence is off", async () => {
    const { dispatch } = fakeDispatch(CLAIMS);
    const res = await sliWave(["cleanPass", "emptyEvidencePass", "malformed"], {
      work,
      ableSchema: ABLE_SCHEMA,
      dispatch,
    });
    for (const r of res) {
      expect(r.receipt.authoritative).toBe(false);
      expect(r.receipt.verdict_adjudicated).not.toBe("PASS"); // PASS_UNVERIFIED at most
    }
  });
});

// P3-a — relevanceQuorum config is validated ONCE at sliWave entry, so a bad
// config fails CONSISTENTLY (even with no critical reproduced items to judge,
// the path that would otherwise never reach relevanceQuorum()).
describe("sliWave — relevanceQuorum config validated at entry (codex P3-a)", () => {
  test.each([0, -1, 1.5, Number.NaN])(
    "bad relevanceQuorum %p throws at entry (before any dispatch)",
    async (bad: number) => {
      const { dispatch } = fakeDispatch(CLAIMS);
      // No verifyEvidence and no evidence to judge — the OLD code would never
      // surface this; entry validation makes it fail consistently.
      await expect(
        sliWave(["cleanPass"], {
          work,
          ableSchema: ABLE_SCHEMA,
          dispatch,
          relevanceQuorum: bad as number,
        }),
      ).rejects.toThrow(/relevanceQuorum must be an integer >= 1/);
    },
  );

  test("a valid integer relevanceQuorum (>=1) does NOT throw", async () => {
    const { dispatch } = fakeDispatch(CLAIMS);
    const res = await sliWave(["cleanPass"], {
      work,
      ableSchema: ABLE_SCHEMA,
      dispatch,
      relevanceQuorum: 3,
    });
    expect(res).toHaveLength(1);
  });
});
