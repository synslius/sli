// examples/lockReceipt.ts — receipt-locking helper shared by the proof runners.
//
// A "locked receipt" is the ProofWheel with its SOLE runtime-stamped field (`ts`)
// excluded from equality. We normalize it to `ts:null` so the on-disk JSON is
// byte-identical run-to-run (spec §6 invariant 5: determinism, run-twice
// byte-equality). The proof harnesses already pass ts:null through sliWave, but
// we force it here so the lock is robust even if a caller stamps a real clock.

import type { ProofWheel } from "../src/proofwheel.ts";

/** Strip the runtime `ts` (the only non-deterministic field) → locked form. */
export function lock(receipt: ProofWheel): ProofWheel {
  return { ...receipt, ts: null };
}

/** Stable JSON serialization of a locked receipt (ts excluded → null). */
export function lockedJson(receipt: ProofWheel): string {
  return JSON.stringify(lock(receipt), null, 2) + "\n";
}

/**
 * Stable JSON serialization of an ARRAY of locked receipts (a whole wave). Same
 * single source of truth as lockedJson so a multi-receipt lock can never drift
 * from the single-receipt one.
 */
export function lockedJsonArray(receipts: ProofWheel[]): string {
  return JSON.stringify(receipts.map(lock), null, 2) + "\n";
}
