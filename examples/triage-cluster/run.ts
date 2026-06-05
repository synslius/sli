#!/usr/bin/env bun
// examples/triage-cluster/run.ts — runnable Proof B (real-task verified FLAG).
//
//   bun examples/triage-cluster/run.ts          # run + print outcome
//   bun examples/triage-cluster/run.ts --write   # ALSO (re)write the locked receipt
//
// Runs the REAL sliWave pipeline against an in-fixture FLAG claim with two
// observed pointers into self-contained bundled fixtures (./fixtures). S3a
// reproduces both; the stub judge entails the finding; evidence_verified:true.
// The receipt is a VERIFIED FINDING (FLAG, not authoritative) routed to the
// findings filter — proving the pipeline carries verification for a FLAG, not
// just a PASS.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { runProofB, isVerifiedFinding } from "./proofs.ts";
import { lockedJson } from "../lockReceipt.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRITE = process.argv.includes("--write");

console.log("=== Proof B — real-task verified FLAG (verifyEvidence:true) ===");
const b = await runProofB();
console.log(`  verdict=${b.verdict_adjudicated}`);
console.log(`  reproduction=[${b.reproduction.map((x) => `${x.item_ref}:${x.reproduced}`).join(", ")}]`);
console.log(`  relevance_quorum=${b.relevance_quorum}`);
console.log(`  evidence_verified=${b.evidence_verified}`);
console.log(`  authoritative=${b.authoritative}  (a FLAG never authorizes action)`);
console.log(`  isVerifiedFinding=${isVerifiedFinding(b)}  → routed to the findings filter`);

if (WRITE) {
  writeFileSync(join(HERE, "proof-b.receipt.json"), lockedJson(b));
  console.log("  wrote proof-b.receipt.json");
}

console.log("\nDone." + (WRITE ? " (receipt written)" : " (run with --write to regenerate the locked receipt)"));
