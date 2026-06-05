// tests/adjudicate-bridge.test.ts — smoke test for the thin stdin→stdout bridge.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
// Import the in-process helper directly for a structural assertion.
import { adjudicateBatch } from "../src/adjudicate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(here, "..", "src", "adjudicate.mjs");

describe("adjudicate.mjs — in-process batch helper", () => {
  test("maps a clean PASS to PASS_UNVERIFIED and an empty PASS to FLAG", () => {
    const out = adjudicateBatch([
      { id: "a", layer: "BEHAVIOR", assertion: "x", evidence: [{ kind: "observed", args: ["s"] }], verdict: { status: "PASS" } },
      { id: "b", layer: "BEHAVIOR", assertion: "y", evidence: [], verdict: { status: "PASS" } },
    ]);
    expect(out[0]!.verdict_adjudicated).toBe("PASS_UNVERIFIED");
    expect(out[1]!.verdict_adjudicated).toBe("FLAG");
  });

  test("duplicate claim_id → BLOCK both (no cross-wire)", () => {
    const out = adjudicateBatch([
      { id: "dup", layer: "BEHAVIOR", assertion: "x", evidence: [{ kind: "observed", args: ["s"] }], verdict: { status: "PASS" } },
      { id: "dup", layer: "BEHAVIOR", assertion: "y", evidence: [{ kind: "observed", args: ["s"] }], verdict: { status: "PASS" } },
    ]);
    expect(out[0]!.verdict_adjudicated).toBe("BLOCK");
    expect(out[1]!.verdict_adjudicated).toBe("BLOCK");
    expect(out[0]!.rules_fired[0]!.code).toBe("MALFORMED_CLAIM");
  });
});

describe("adjudicate.mjs — stdin→stdout CLI bridge", () => {
  test("reads claims JSON from stdin, writes Adjudication[] JSON to stdout", () => {
    const input = JSON.stringify([
      { id: "a", layer: "BEHAVIOR", assertion: "x", evidence: [{ kind: "observed", args: ["s"] }], verdict: { status: "PASS" } },
    ]);
    const res = spawnSync("node", [bridgePath], { input, encoding: "utf8" });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].claim_id).toBe("a");
    expect(parsed[0].verdict_adjudicated).toBe("PASS_UNVERIFIED");
  });

  test("invalid JSON on stdin → non-zero exit (fails loudly)", () => {
    const res = spawnSync("node", [bridgePath], { input: "not json", encoding: "utf8" });
    expect(res.status).not.toBe(0);
  });
});
