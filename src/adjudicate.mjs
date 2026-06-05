#!/usr/bin/env node
// src/adjudicate.mjs — thin Node ESM bridge (Slice-1 workflow-embed artifact)
//
// Reads claims JSON from stdin, imports adjudicate from ablesyn, writes an
// Adjudication[] JSON array to stdout. Per-claim try/catch → BLOCK +
// ADJUDICATE_THREW. Duplicate claim_id in the batch → BLOCK + MALFORMED_CLAIM
// (no cross-wire). Association is POSITIONAL — the caller maps results by index,
// never by worker claim_id.
//
// NOTE: the standalone sliWave S2 path imports adjudicate() DIRECTLY (see
// src/sliWave.ts). This .mjs bridge exists for the future Slice-1 path where the
// adjudicator runs inside a Dynamic Workflow agent (claims passed via a written
// file, not prompt-embedded). Runtime is pinned: ESM .mjs importing the built
// ablesyn dist; a version/extension mismatch fails loudly rather than silently
// zeroing a wave.

import { adjudicate } from "ablesyn";

function blockResult(claimId, code, message) {
  return {
    claim_id: typeof claimId === "string" ? claimId : "",
    verdict_claimed: "BLOCK",
    verdict_adjudicated: "BLOCK",
    rules_fired: [{ code, severity: "error", message }],
    ok: false,
    hard_structural: true,
  };
}

export function adjudicateBatch(claims) {
  if (!Array.isArray(claims)) {
    throw new Error("adjudicate.mjs: input must be a JSON array of claims");
  }
  // Pre-scan for duplicate claim_ids (cross-wire hazard).
  const counts = new Map();
  for (const claim of claims) {
    const id = claim && typeof claim === "object" && typeof claim.id === "string" ? claim.id : undefined;
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const dup = new Set();
  for (const [id, n] of counts) if (n > 1) dup.add(id);

  return claims.map((claim) => {
    const id = claim && typeof claim === "object" && typeof claim.id === "string" ? claim.id : undefined;
    if (id !== undefined && dup.has(id)) {
      return blockResult(id, "MALFORMED_CLAIM", `duplicate claim_id ${JSON.stringify(id)} in batch — BLOCK (no cross-wire)`);
    }
    try {
      return adjudicate(claim);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return blockResult(id, "ADJUDICATE_THREW", `adjudicate threw: ${message}`);
    }
  });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  let claims;
  try {
    claims = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`adjudicate.mjs: invalid JSON on stdin: ${e.message}\n`);
    process.exit(2);
    return;
  }
  let out;
  try {
    out = adjudicateBatch(claims);
  } catch (e) {
    process.stderr.write(`adjudicate.mjs: ${e.message}\n`);
    process.exit(2);
    return;
  }
  process.stdout.write(JSON.stringify(out));
}

// Run as CLI only when invoked directly (not when imported by a test).
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((e) => {
    process.stderr.write(`adjudicate.mjs: ${e?.message ?? e}\n`);
    process.exit(1);
  });
}
