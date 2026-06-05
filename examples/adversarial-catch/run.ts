#!/usr/bin/env bun
// examples/adversarial-catch/run.ts — runnable Proof A / A′ / A″ / A‴.
//
//   bun examples/adversarial-catch/run.ts          # run + print outcomes
//   bun examples/adversarial-catch/run.ts --write   # ALSO (re)write locked receipts
//
// Each proof runs the REAL sliWave pipeline against in-fixture planted claims and
// self-contained bundled fixtures (./fixtures). The 4 cheats are PERMANENT
// REGRESSION GUARDS: if a future change lets any cheat through, the proof's
// assertion in tests/proofs.test.ts fails loudly. The locked receipts (ts
// excluded) are the byte-identical evidence of each proof's outcome.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import {
  runProofA,
  runProofAPrime,
  runProofADoublePrime,
  runProofATriplePrime,
} from "./proofs.ts";
import { lockedJson, lockedJsonArray } from "../lockReceipt.ts";
import type { ProofWheel } from "../../src/proofwheel.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRITE = process.argv.includes("--write");

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function summarize(label: string, r: ProofWheel): string {
  return `${pad(label, 26)} verdict=${pad(r.verdict_adjudicated, 16)} ev=${pad(String(r.evidence_verified), 5)} auth=${r.authoritative}`;
}

function maybeWrite(file: string, receipt: ProofWheel): void {
  if (!WRITE) return;
  writeFileSync(join(HERE, file), lockedJson(receipt));
  console.log(`  wrote ${file}`);
}

console.log("=== Proof A — structural (verifyEvidence:false): 5 planted claims ===");
const a = await runProofA();
const A_LABELS: Record<string, string> = {
  empty_evidence: "cheat: empty-evidence",
  admits_missing: "cheat: admits-missing",
  inferred_only: "cheat: inferred-only",
  motivation_as_proof: "cheat: motivation-as-proof",
  honest_observed: "honest: observed PASS",
};
for (const r of a) console.log("  " + summarize(A_LABELS[r.claim_id] ?? r.claim_id, r));
// Locked receipt for the whole wave (array of 5) — routed through the ONE
// shared lock helper so "locked" has a single source of truth (codex P3-c).
if (WRITE) {
  writeFileSync(join(HERE, "proof-a.receipt.json"), lockedJsonArray(a));
  console.log("  wrote proof-a.receipt.json");
}

console.log("\n=== Proof A′ — fabricated-ABSENT (verifyEvidence:true) ===");
const ap = await runProofAPrime();
console.log("  " + summarize("A′ absent path", ap) +
  ` reproduced=${ap.reproduction[0]?.reproduced} reachable=${ap.reproduction[0]?.reachable}`);
maybeWrite("proof-a-prime.receipt.json", ap);

console.log("\n=== Proof A″ — fabricated-PRESENT-BUT-UNRELATED (verifyEvidence:true) ===");
const adp = await runProofADoublePrime();
console.log("  " + summarize("A″ present-unrelated", adp) +
  ` reproduced=${adp.reproduction[0]?.reproduced} quorum=${adp.relevance_quorum}`);
maybeWrite("proof-a-doubleprime.receipt.json", adp);

console.log("\n=== Proof A‴ — HONEST positive (verifyEvidence:true) ===");
const atp = await runProofATriplePrime();
console.log("  " + summarize("A‴ honest positive", atp) +
  ` reproduced=${atp.reproduction[0]?.reproduced} quorum=${atp.relevance_quorum}`);
maybeWrite("proof-a-tripleprime.receipt.json", atp);

console.log("\nDone." + (WRITE ? " (receipts written)" : " (run with --write to regenerate locked receipts)"));
