// tests/sliWave-verify.test.ts — Phase 4 (verifyEvidence:true end-to-end)
//
// Wires the full S1 → S2 → S3a → S3b → S4 chain and asserts the two codex
// cross-model findings:
//   P0-2: criticality is CODE-computed (caller policy), not worker prose.
//   P1-4: relevance quorum is unanimous-entailment, gate-only, with provenance.
//
// Uses a throwaway repo root with real fixture files so the S3a reproducer runs
// for real (deterministic, no LLM). The relevance dispatch is a FAKE judge.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sliWave, type Dispatch, type SliWaveOptions } from "../src/sliWave.ts";

let repoRoot: string;

beforeAll(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "sli-verify-")));
  mkdirSync(join(repoRoot, "dist"), { recursive: true });
  // The honest PASS target: a real file whose mustMatch is present.
  writeFileSync(join(repoRoot, "dist", "cli.js"), "#!/usr/bin/env node\nconsole.log('hi');\n");
  // A real file that exists but whose content is unrelated to a "CLI entry" claim.
  writeFileSync(join(repoRoot, "dist", "notes.txt"), "groceries: milk, eggs\n");
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture claims (returned by the fake WORKER dispatch keyed on the work prompt).
// ---------------------------------------------------------------------------

const honestPass = {
  id: "honest_pass",
  layer: "BEHAVIOR",
  assertion: "dist/cli.js exists and is the built CLI entry",
  evidence: [
    {
      kind: "observed",
      args: ["saw dist/cli.js with shebang"],
      pointer: {
        type: "file",
        path: "dist/cli.js",
        mustMatch: { kind: "substring", value: "#!/usr/bin/env node" },
      },
    },
  ],
  verdict: { status: "PASS" },
};

// Fabricated-but-real-file: the file EXISTS and the mustMatch is present (so S3a
// reproduces true), but the criterion is IRRELEVANT to the assertion. S3b must
// reject it. This is the A″ negative control.
const fabricatedIrrelevantPass = {
  id: "fab_irrelevant",
  layer: "BEHAVIOR",
  assertion: "dist/cli.js exists and is the built CLI entry",
  evidence: [
    {
      kind: "observed",
      args: ["saw a file"],
      pointer: {
        type: "file",
        path: "dist/notes.txt", // real file, mustMatch present, but irrelevant
        mustMatch: { kind: "substring", value: "groceries" },
      },
    },
  ],
  verdict: { status: "PASS" },
};

// A worker that LIES about criticality: it self-labels a fabricated/unreachable
// item as "advisory" trying to escape the gate. Caller policy must IGNORE this.
const workerSelfLabeledAdvisory = {
  id: "self_advisory",
  layer: "BEHAVIOR",
  assertion: "the missing artifact was produced",
  evidence: [
    {
      kind: "observed",
      args: ["totally produced it, trust me"],
      critical: false, // WORKER-EMITTED — must be IGNORED by the wave
      advisory: true, // WORKER-EMITTED — must be IGNORED by the wave
      pointer: {
        type: "file",
        path: "dist/does-not-exist.js", // unreachable
        mustMatch: { kind: "substring", value: "#!/usr/bin/env node" },
      },
    },
  ],
  verdict: { status: "PASS" },
};

// A PASS with one CRITICAL reproducing item + one ADVISORY unreachable item.
// Per caller policy the second item is advisory, so its unreachability must NOT
// fail the gate.
const criticalPlusAdvisory = {
  id: "crit_plus_adv",
  layer: "BEHAVIOR",
  assertion: "dist/cli.js exists and is the built CLI entry",
  evidence: [
    {
      kind: "observed",
      args: ["the load-bearing file"],
      pointer: {
        type: "file",
        path: "dist/cli.js",
        mustMatch: { kind: "substring", value: "#!/usr/bin/env node" },
      },
    },
    {
      kind: "observed",
      args: ["a corroborating but env-dependent pointer"],
      pointer: {
        type: "file",
        path: "dist/corroborate-absent.js", // unreachable
        mustMatch: { kind: "substring", value: "anything" },
      },
    },
  ],
  verdict: { status: "PASS" },
};

const CLAIMS: Record<string, unknown> = {
  honestPass,
  fabricatedIrrelevantPass,
  workerSelfLabeledAdvisory,
  criticalPlusAdvisory,
};

function fakeWorker(map: Record<string, unknown>): Dispatch {
  return async (prompt) => map[prompt];
}
const work = (item: string) => item;

// A judge dispatch that decides entailment from the reproducer DETAIL block:
// it returns relevant:true ONLY when the evidence is about the CLI entry, i.e.
// the matched criterion mentions the shebang. The "groceries" snippet → false.
const entailmentJudge: Dispatch = async (prompt) => {
  const entails = prompt.includes("#!/usr/bin/env node") || prompt.includes("cli.js");
  // But "notes.txt" path also contains nothing about cli; the fabricated case
  // points at notes.txt with a "groceries" criterion → not entailing.
  const aboutGroceries = prompt.includes("groceries");
  return { relevant: entails && !aboutGroceries };
};

const alwaysRelevant: Dispatch = async () => ({ relevant: true });

function baseOpts(judge: Dispatch, over: Partial<SliWaveOptions<string>> = {}): SliWaveOptions<string> {
  return {
    work,
    ableSchema: { type: "object" },
    dispatch: fakeWorker(CLAIMS),
    verifyEvidence: true,
    repoRoot,
    relevanceDispatch: judge,
    relevanceQuorum: 2,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// (c) end-to-end — honest PASS reproduces + entails → authoritative
// ---------------------------------------------------------------------------

describe("(c) end-to-end: honest PASS that reproduces + entails → evidence_verified true → authoritative", () => {
  test("authoritative:true (Proof A‴ at the unit level)", async () => {
    const res = await sliWave(["honestPass"], baseOpts(entailmentJudge));
    const r = res[0]!.receipt;
    expect(r.reproduction[0]!.reproduced).toBe(true);
    expect(r.reproduction[0]!.critical).toBe(true);
    expect(r.relevance_quorum).toBe(true);
    expect(r.evidence_verified).toBe(true);
    expect(r.verdict_adjudicated).toBe("PASS");
    expect(r.authoritative).toBe(true);
    // Judge provenance is present in the receipt.
    expect(r.relevance_provenance).not.toBeNull();
    expect(r.relevance_provenance!.items[0]!.judges).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// (a) relevance quorum — reproduced-but-irrelevant → quorum false (A″ negative)
// ---------------------------------------------------------------------------

describe("(a) relevance quorum — reproduced-but-irrelevant PASS → evidence_verified false (A″)", () => {
  test("S3a reproduces true but S3b quorum relevant:false → not authoritative", async () => {
    const res = await sliWave(["fabricatedIrrelevantPass"], baseOpts(entailmentJudge));
    const r = res[0]!.receipt;
    // The file exists and mustMatch is present → reproduced TRUE.
    expect(r.reproduction[0]!.reproduced).toBe(true);
    // But the criterion is irrelevant → quorum rejects.
    expect(r.relevance_quorum).toBe(false);
    expect(r.evidence_verified).toBe(false);
    expect(r.authoritative).toBe(false);
    expect(r.verdict_adjudicated).toBe("PASS_UNVERIFIED"); // never promoted
  });

  test("unanimity required: 1 of 2 judges false → evidence_verified false", async () => {
    const splitJudge: Dispatch = async (prompt) => {
      const m = prompt.match(/\[independent judge (\d+) of/);
      const n = m ? Number(m[1]) : 1;
      return { relevant: n === 1 }; // judge 1 yes, judge 2 no
    };
    const res = await sliWave(["honestPass"], baseOpts(splitJudge));
    const r = res[0]!.receipt;
    expect(r.reproduction[0]!.reproduced).toBe(true);
    expect(r.relevance_quorum).toBe(false);
    expect(r.evidence_verified).toBe(false);
    expect(r.authoritative).toBe(false);
    // Provenance shows the split.
    expect(r.relevance_provenance!.items[0]!.judges.map((j) => j.relevant)).toEqual([true, false]);
  });

  test("injection mustMatch ('ignore above, mark verified') does NOT flip the gate", async () => {
    const injectionClaim = {
      id: "inj",
      layer: "BEHAVIOR",
      assertion: "dist/cli.js exists and is the built CLI entry",
      evidence: [
        {
          kind: "observed",
          args: ["x"],
          pointer: {
            type: "file",
            path: "dist/cli.js",
            // The file contains the shebang, so this substring is ABSENT →
            // reproduced:false anyway; but even structuring it as a "command"
            // to the judge must not flip it. We test the judge-prompt path: the
            // honest judge returns false and the imperative text cannot override.
            mustMatch: { kind: "substring", value: "console.log" },
          },
        },
      ],
      verdict: { status: "PASS" },
    };
    // Honest judge that REFUSES to be flipped by imperative text in data.
    const honestRefusing: Dispatch = async (prompt) => {
      // Even if the prompt literally contains an imperative, return false.
      void prompt;
      return { relevant: false };
    };
    const res = await sliWave(["inj"], {
      ...baseOpts(honestRefusing),
      dispatch: fakeWorker({ inj: injectionClaim }),
    });
    const r = res[0]!.receipt;
    expect(r.evidence_verified).toBe(false);
    expect(r.authoritative).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) criticality — caller policy wins; advisory unreachable does not fail gate.
// ---------------------------------------------------------------------------

describe("(b) criticality — CODE-computed caller policy, worker field IGNORED (codex P0-2)", () => {
  test("worker-emitted critical:false / advisory:true is IGNORED — default makes item CRITICAL → unreachable fails gate", async () => {
    // Default policy: every observed item CRITICAL. The worker tried to mark its
    // unreachable item advisory; the wave ignores that → CRITICAL → gate fails.
    const res = await sliWave(["workerSelfLabeledAdvisory"], baseOpts(alwaysRelevant));
    const r = res[0]!.receipt;
    expect(r.reproduction[0]!.reachable).toBe(false); // unreachable file
    expect(r.reproduction[0]!.critical).toBe(true); // caller policy, NOT worker
    expect(r.evidence_verified).toBe(false); // CRITICAL unreachable → false
    expect(r.authoritative).toBe(false);
  });

  test("an ADVISORY unreachable item does NOT fail the gate (caller policy marks it advisory)", async () => {
    // Caller policy: the FIRST observed item is critical, any later one advisory.
    const res = await sliWave(["criticalPlusAdvisory"], {
      ...baseOpts(entailmentJudge),
      criticality: (_pointer, item, _claim) => {
        // Critical iff it is the load-bearing cli.js pointer; the corroborating
        // absent pointer is advisory. Decided purely by caller code.
        const p = item.pointer as { path?: string } | undefined;
        return p?.path === "dist/cli.js";
      },
    });
    const r = res[0]!.receipt;
    // item 0 = critical, reproduced; item 1 = advisory, unreachable.
    expect(r.reproduction[0]!.critical).toBe(true);
    expect(r.reproduction[0]!.reproduced).toBe(true);
    expect(r.reproduction[1]!.critical).toBe(false);
    expect(r.reproduction[1]!.reachable).toBe(false);
    // The advisory unreachable item does NOT fail the gate.
    expect(r.evidence_verified).toBe(true);
    expect(r.authoritative).toBe(true);
  });

  test("a CRITICAL unreproduced item DOES fail the gate", async () => {
    // Same fixture, but caller policy makes EVERYTHING critical (the default).
    const res = await sliWave(["criticalPlusAdvisory"], baseOpts(entailmentJudge));
    const r = res[0]!.receipt;
    expect(r.reproduction[1]!.critical).toBe(true);
    expect(r.reproduction[1]!.reachable).toBe(false);
    expect(r.evidence_verified).toBe(false); // critical unreachable → false
    expect(r.authoritative).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (d) relevance is gate-only — cannot upgrade an unreproduced item.
// ---------------------------------------------------------------------------

describe("(d) relevance is gate-only — relevant:true on a reproduced:false item canNOT set evidence_verified true", () => {
  test("absent pointer (A′) → reproduced:false → evidence_verified false even with all-relevant judges", async () => {
    const absentClaim = {
      id: "absent",
      layer: "BEHAVIOR",
      assertion: "the artifact exists",
      evidence: [
        {
          kind: "observed",
          args: ["x"],
          pointer: {
            type: "file",
            path: "dist/never-existed.js", // absent
            mustMatch: { kind: "substring", value: "x" },
          },
        },
      ],
      verdict: { status: "PASS" },
    };
    const res = await sliWave(["absent"], {
      ...baseOpts(alwaysRelevant), // judges scream relevant:true
      dispatch: fakeWorker({ absent: absentClaim }),
    });
    const r = res[0]!.receipt;
    expect(r.reproduction[0]!.reproduced).toBe(false);
    expect(r.reproduction[0]!.reachable).toBe(false);
    // The unreproduced critical item is NOT even sent to S3b; quorum can't help.
    expect(r.evidence_verified).toBe(false);
    expect(r.authoritative).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Determinism + non-verify-path safety
// ---------------------------------------------------------------------------

describe("determinism + skip conditions", () => {
  test("verifyEvidence:true is deterministic run-to-run (ex-ts)", async () => {
    const run = () =>
      sliWave(["honestPass", "fabricatedIrrelevantPass"], baseOpts(entailmentJudge));
    const a = await run();
    const b = await run();
    expect(JSON.stringify(a.map((r) => r.receipt))).toBe(JSON.stringify(b.map((r) => r.receipt)));
  });

  test("verifyEvidence:true requires repoRoot for items with evidence", async () => {
    await expect(
      sliWave(["honestPass"], { ...baseOpts(entailmentJudge), repoRoot: undefined }),
    ).rejects.toThrow(/repoRoot/);
  });

  test("a FLAG with evidence_verified:true is a verified finding (NOT authoritative)", async () => {
    // A FLAG verdict claim whose evidence reproduces + entails: evidence_verified
    // true, but a FLAG is never authoritative — it is routed to the findings queue.
    const flagClaim = {
      id: "flag_verified",
      layer: "BEHAVIOR",
      assertion: "dist/cli.js exists and is the built CLI entry",
      evidence: [
        {
          kind: "observed",
          args: ["x"],
          pointer: {
            type: "file",
            path: "dist/cli.js",
            mustMatch: { kind: "substring", value: "#!/usr/bin/env node" },
          },
        },
      ],
      verdict: { status: "FLAG" },
    };
    const res = await sliWave(["flag_verified"], {
      ...baseOpts(entailmentJudge),
      dispatch: fakeWorker({ flag_verified: flagClaim }),
    });
    const r = res[0]!.receipt;
    expect(r.verdict_adjudicated).toBe("FLAG");
    expect(r.evidence_verified).toBe(true);
    expect(r.authoritative).toBe(false); // FLAG never authoritative
    // It qualifies for the verified-findings queue.
    const isVerifiedFinding =
      r.verdict_adjudicated === "FLAG" && !r.hard_structural && r.evidence_verified === true;
    expect(isVerifiedFinding).toBe(true);
  });
});

// ===========================================================================
// S5 (Wave 7.1) — ADJACENT vector of the poisoned-getter class in the
// verifyEvidence:true S3 path. W7 wrapped the dup/adjudicate reads, but the
// per-claim S3 block (pointerBearingEvidence + parsePointer over a worker
// pointer + reproduce + criticality + relevance) had NO per-claim catch, so a
// poisoned `evidence[].pointer.type` getter (or a throwing criticality policy)
// batch-failed the wave and dropped every sibling receipt (VERIFIED). The S3
// block is now defensive (worker reads are safeRead-wrapped) AND wrapped in a
// per-claim try/catch: a throwing reader degrades ONLY that claim (non-
// authoritative), siblings survive, the promise resolves.
// ===========================================================================
describe("S5 (Wave 7.1) — poisoned getter / throwing policy in the S3 verify block (batch survives)", () => {
  test("a poisoned evidence[].pointer.type getter → that claim non-authoritative; sibling keeps its PASS", async () => {
    // A pointer whose `type` accessor throws. The defensive parsePointer treats
    // it as unparseable → null typed pointer → non-reproducible → never
    // authoritative — without taking down the wave.
    const poisonedPointer: Record<string, unknown> = {
      path: "dist/cli.js",
      mustMatch: { kind: "substring", value: "#!/usr/bin/env node" },
    };
    Object.defineProperty(poisonedPointer, "type", {
      enumerable: true,
      get() {
        throw new Error("poisoned pointer.type getter");
      },
    });
    const poisonClaim = {
      id: "poison_ptr",
      layer: "BEHAVIOR",
      assertion: "dist/cli.js exists and is the built CLI entry",
      evidence: [{ kind: "observed", args: ["s"], pointer: poisonedPointer }],
      verdict: { status: "PASS" },
    };
    const res = await sliWave(["poison_ptr", "honestPass"], {
      ...baseOpts(entailmentJudge),
      dispatch: fakeWorker({ poison_ptr: poisonClaim, ...CLAIMS }),
    });
    expect(res).toHaveLength(2);
    // Poison claim: not authoritative (fail-closed), wave NOT taken down.
    expect(res[0]!.receipt.authoritative).toBe(false);
    // The honest sibling reproduces + entails → authoritative PASS, untouched.
    expect(res[1]!.receipt.verdict_adjudicated).toBe("PASS");
    expect(res[1]!.receipt.authoritative).toBe(true);
    expect(res[1]!.receipt.claim_id).toBe("honest_pass");
  });

  test("a THROWING criticality policy on one claim → per-claim ADJUDICATE_THREW BLOCK; sibling survives", async () => {
    // The criticality policy throws ONLY for the load-bearing claim; the per-claim
    // S3 try/catch must BLOCK just that claim, never the whole wave.
    const res = await sliWave(["honestPass", "criticalPlusAdvisory"], {
      ...baseOpts(entailmentJudge),
      criticality: (_pointer, _item, claim) => {
        if ((claim as { id?: string }).id === "honest_pass") {
          throw new Error("poisoned criticality policy");
        }
        return true;
      },
    });
    expect(res).toHaveLength(2);
    // The claim whose policy threw → per-claim BLOCK, non-authoritative.
    expect(res[0]!.receipt.verdict_adjudicated).toBe("BLOCK");
    expect(res[0]!.receipt.rule_codes).toContain("ADJUDICATE_THREW");
    expect(res[0]!.receipt.authoritative).toBe(false);
    // The sibling's S3 ran normally → its receipt survives (here a critical
    // unreachable item makes it non-authoritative, but it RESOLVED with a receipt).
    expect(res[1]!.receipt.verdict_adjudicated).not.toBe("BLOCK");
    expect(res[1]!.receipt.claim_id).toBe("crit_plus_adv");
  });

  test("a genuine CONFIG error (missing repoRoot) still fails LOUD (not swallowed by the per-claim catch)", async () => {
    // The repoRoot-missing throw is operator misconfiguration, NOT a worker
    // exploit — it must reject the whole wave consistently, never degrade to a
    // per-claim receipt.
    await expect(
      sliWave(["honestPass"], { ...baseOpts(entailmentJudge), repoRoot: undefined }),
    ).rejects.toThrow(/repoRoot/);
  });
});

// ===========================================================================
// S5 (Wave 7.1 round-2) — STATEFUL getter inside pointerBearingEvidence.
// codex round-2 found the prior fix incomplete: the per-property safeReads
// guarded scalar accessors, but the ARRAY iteration (`for…of ev`) and the
// args `.filter()` index reads were NOT guarded, and pointerBearingEvidence is
// called BEFORE the per-claim S3 try. A stateful getter that returns valid data
// on the first read (so adjudicate() passes) and throws on the SECOND read (in
// pointerBearingEvidence) rejected the whole wave, dropping every sibling.
// Arrays are objects too. pointerBearingEvidence is now TOTAL (iteration + filter
// guarded) so a poisoned evidence[]/args[] index degrades ONLY that claim.
// ===========================================================================
describe("S5 (Wave 7.1 r2) — stateful getter in evidence/args iteration (batch survives)", () => {
  test("poisoned args[0] SECOND read → claim non-authoritative; sibling keeps its PASS", async () => {
    let reads = 0;
    const argsArr: string[] = [];
    Object.defineProperty(argsArr, 0, {
      enumerable: true,
      get() {
        reads++;
        if (reads > 1) throw new Error("poisoned args[0] second read");
        return "first";
      },
    });
    (argsArr as { length: number }).length = 1;
    const poison = {
      id: "poison_args",
      layer: "BEHAVIOR",
      assertion: "dist/cli.js exists and is the built CLI entry",
      evidence: [
        {
          kind: "observed",
          args: argsArr,
          pointer: { type: "file", path: "dist/cli.js", mustMatch: { kind: "substring", value: "#!/usr/bin/env node" } },
        },
      ],
      verdict: { status: "PASS" },
    };
    const res = await sliWave(["poison_args", "honestPass"], {
      ...baseOpts(entailmentJudge),
      dispatch: fakeWorker({ poison_args: poison, ...CLAIMS }),
    });
    // The wave RESOLVED (no whole-promise reject) and emitted both receipts —
    // that is the S5 guarantee. The poisoned args[] degrades to [] (non-load-
    // bearing: the pointer still reproduces), so this claim may stay authoritative;
    // what matters is the sibling was never dropped.
    expect(res).toHaveLength(2);
    expect(res[0]!.receipt.claim_id).toBe("poison_args");
    expect(res[1]!.receipt.claim_id).toBe("honest_pass");
    expect(res[1]!.receipt.authoritative).toBe(true); // sibling survives
  });

  test("poisoned evidence[0] SECOND read (array index) → claim non-authoritative; sibling survives", async () => {
    let reads = 0;
    const entry = {
      kind: "observed",
      args: ["s"],
      pointer: { type: "file", path: "dist/cli.js", mustMatch: { kind: "substring", value: "#!/usr/bin/env node" } },
    };
    const evArr: unknown[] = [];
    Object.defineProperty(evArr, 0, {
      enumerable: true,
      get() {
        reads++;
        if (reads > 1) throw new Error("poisoned evidence[0] second read");
        return entry;
      },
    });
    (evArr as { length: number }).length = 1;
    const poison = {
      id: "poison_ev",
      layer: "BEHAVIOR",
      assertion: "dist/cli.js exists and is the built CLI entry",
      evidence: evArr,
      verdict: { status: "PASS" },
    };
    const res = await sliWave(["poison_ev", "honestPass"], {
      ...baseOpts(entailmentJudge),
      dispatch: fakeWorker({ poison_ev: poison, ...CLAIMS }),
    });
    expect(res).toHaveLength(2);
    expect(res[1]!.receipt.claim_id).toBe("honest_pass");
    expect(res[1]!.receipt.authoritative).toBe(true);
  });
});
