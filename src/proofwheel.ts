// src/proofwheel.ts — Phase 3 (S4 receipt)
//
// ProofWheel: the structural receipt. evidence_verified is CODE-derived here
// (spec §4.3, §6 invariant 2) — never an agent boolean. Wave 2 implements the
// structural path (verifyEvidence:false → S3 skipped → evidence_verified:null).
//
// Dependency-free except for the ablesyn Adjudication type.

import type { Adjudication } from "ablesyn";
import type { ReproRecord } from "./pointer.ts";

/**
 * S3b judge provenance (codex P1-4). Per reproduced CRITICAL item, the list of
 * judge booleans that were produced for it, plus the aggregate unanimity. This
 * is recorded verbatim in the receipt so the soft relevance judgment is
 * auditable. Dependency-free shape (mirrors relevance.ts RelevanceReceipt).
 */
export interface RelevanceProvenance {
  /** Number of independent judges dispatched per item (the configured quorum). */
  quorum: number;
  /** Per-item judge trail (only items that reached S3b, i.e. reproduced && critical). */
  items: {
    item_ref: string;
    judges: { judge: number; relevant: boolean }[];
    /** Unanimity over this item's judges. */
    relevant: boolean;
  }[];
}

export interface ProofWheel {
  wave_key: string;
  claim_id: string;
  layer: string;
  assertion: string;
  verdict_claimed: string;
  verdict_adjudicated: "PASS" | "PASS_UNVERIFIED" | "FLAG" | "BLOCK";
  ok: boolean; // projected ablesyn CheckResult.ok
  hard_structural: boolean;
  rule_codes: string[]; // map(r => r.code) of Adjudication.rules_fired
  reproduction: { item_ref: string; reproduced: boolean; reachable: boolean; critical: boolean; detail: object }[]; // S3a records (critical = caller-policy designation, codex P0-2)
  relevance_quorum: boolean | null; // S3b aggregate outcome over CRITICAL reproduced items (null if S3 skipped)
  /**
   * S3b judge PROVENANCE (codex P1-4): which judges ran on each item and their
   * individual booleans. null when S3 skipped. Records the soft-judgment trail
   * so a relevance pass is auditable, not an opaque LGTM.
   */
  relevance_provenance: RelevanceProvenance | null;
  evidence_verified: boolean | null; // CODE-derived; never an agent boolean
  authoritative: boolean; // verdict_adjudicated==="PASS" && evidence_verified===true && !hard_structural
  claim_json: object;
  ts: number | null; // SOLE runtime-stamped field; excluded from fixture equality
}

export interface ReproductionItem {
  item_ref: string;
  record: ReproRecord;
  /**
   * CODE-level criticality (codex P0-2). Decided by the WAVE CONFIG / caller
   * policy, NEVER by a worker-emitted field. evidence_verified quantifies ONLY
   * over CRITICAL items: a CRITICAL item that is unreachable/unreproduced/
   * irrelevant → evidence_verified false; an ADVISORY item that is unreachable
   * does NOT fail the gate (but is still recorded in the receipt).
   *
   * Optional for back-compat: when omitted, the item is treated as CRITICAL
   * (the strict/fail-closed default — caller policy must explicitly mark an item
   * advisory to relax the gate for it).
   */
  critical?: boolean;
}

export interface BuildProofWheelInput {
  wave_key: string;
  adjudication: Adjudication;
  /** The raw worker claim JSON, stored as claim_json (N6: no .able rendering). */
  claim_json: Record<string, unknown>;
  /** The prose-free assertion (the relevance judge's only claim-side input). */
  assertion: string;
  layer: string;
  /**
   * S3 ran? When false (Wave 2 structural path / verifyEvidence:false) the S3a
   * records + S3b quorum are absent → evidence_verified:null.
   */
  s3Ran: boolean;
  /** S3a reproduction records (empty / ignored when s3Ran === false). */
  reproduction?: ReproductionItem[];
  /** S3b relevance quorum outcome (null when s3Ran === false). */
  relevanceQuorum?: boolean | null;
  /** S3b judge provenance (null when s3Ran === false or S3b did not run). */
  relevanceProvenance?: RelevanceProvenance | null;
  /** Set true only for deterministic fixtures / tests; otherwise Date.now(). */
  ts?: number | null;
}

/** An item is CRITICAL unless caller policy explicitly marked it advisory. */
function isCritical(item: ReproductionItem): boolean {
  return item.critical !== false;
}

/**
 * Derive evidence_verified PURELY from S3a records ∧ S3b quorum (spec §4.3
 * keystone). No agent ever emits this field.
 *
 * The reachable/reproduced quantifiers range ONLY over CRITICAL items (codex
 * P0-2): an ADVISORY item that is unreachable/unreproduced does NOT fail the
 * gate (it is still recorded in the receipt). A worker cannot escape the gate
 * by self-labelling fabricated support "advisory" — criticality is set by
 * caller policy in `sliWave`, never by a worker-emitted field.
 *
 *   if (S3 did not run)                                → null  (PASS stays PASS_UNVERIFIED)
 *   else if (NO CRITICAL item exists at all)           → null  (vacuous-pass guard, below)
 *   else if (any CRITICAL record.reachable === false)  → false (honest "couldn't reach")
 *   else if (any CRITICAL record.reproduced === false) → false
 *   else if (relevance_quorum !== true)                → false
 *   else                                               → true
 *
 * VACUOUS-PASS GUARD (Wave-3 review foot-gun): the reachable/reproduced/quorum
 * checks all quantify over the CRITICAL set. With an EMPTY critical set every
 * `∀` is vacuously satisfied and the relevance quorum is vacuously unanimous, so
 * the naive derivation would return `true` from ZERO observed/external evidence
 * — promoting PASS_UNVERIFIED→PASS on nothing. A worker cannot reach this
 * (criticality is caller policy, default-CRITICAL), but a caller POLICY that
 * marks every item advisory, or a claim whose only evidence is inferred/missing
 * (so no observed/external item ever reaches S3a), would. We close it: if there
 * is no CRITICAL item carrying reproduced evidence, `evidence_verified` is NULL
 * (there is nothing verified), never true. NULL (not false) keeps the structural
 * verdict at PASS_UNVERIFIED — the claim is unverified, not falsified.
 *
 * `relevanceQuorum` is itself a code-derived aggregate over the CRITICAL
 * reproduced items (computed by the caller from independent judges); it is
 * GATE-ONLY — it can only keep evidence_verified false, never set it true on
 * its own (true also requires at least one critical item, all reproduced &
 * reachable).
 */
export function deriveEvidenceVerified(
  s3Ran: boolean,
  reproduction: ReproductionItem[],
  relevanceQuorum: boolean | null,
): boolean | null {
  if (!s3Ran) return null;
  // VACUOUS-PASS GUARD: a `true` result must be SUPPORTED by at least one
  // CRITICAL item. With an empty critical set (caller marked everything advisory,
  // or there was no observed/external evidence at all) every ∀-check below is
  // vacuously satisfied and the relevance quorum is vacuously unanimous, so the
  // naive derivation would return `true` from ZERO evidence. Close it: no
  // critical item → NULL (unverified, not falsified → PASS stays PASS_UNVERIFIED).
  const criticalItems = reproduction.filter(isCritical);
  if (criticalItems.length === 0) return null;
  for (const item of reproduction) {
    if (isCritical(item) && item.record.reachable === false) return false;
  }
  for (const item of reproduction) {
    if (isCritical(item) && item.record.reproduced === false) return false;
  }
  if (relevanceQuorum !== true) return false;
  return true;
}

export function buildProofWheel(input: BuildProofWheelInput): ProofWheel {
  const adj = input.adjudication;
  const reproduction = input.s3Ran ? input.reproduction ?? [] : [];
  const relevanceQuorum = input.s3Ran ? input.relevanceQuorum ?? null : null;
  const relevanceProvenance = input.s3Ran ? input.relevanceProvenance ?? null : null;

  const evidence_verified = deriveEvidenceVerified(input.s3Ran, reproduction, relevanceQuorum);

  // Hard invariant (spec §4.3): an ok===false item can never be
  // evidence_verified:true. Fail loud if code paths ever violate this.
  if (evidence_verified === true && adj.ok === false) {
    throw new Error(
      `proofwheel invariant violated: evidence_verified:true with ok:false (claim_id=${adj.claim_id})`,
    );
  }

  let verdict_adjudicated = adj.verdict_adjudicated;
  // S3 promotes PASS_UNVERIFIED → PASS ONLY when evidence_verified===true.
  if (verdict_adjudicated === "PASS_UNVERIFIED" && evidence_verified === true) {
    verdict_adjudicated = "PASS";
  }

  const authoritative =
    verdict_adjudicated === "PASS" && evidence_verified === true && !adj.hard_structural;

  return {
    wave_key: input.wave_key,
    claim_id: adj.claim_id,
    layer: input.layer,
    assertion: input.assertion,
    verdict_claimed: adj.verdict_claimed,
    verdict_adjudicated,
    ok: adj.ok,
    hard_structural: adj.hard_structural,
    rule_codes: adj.rules_fired.map((r) => r.code),
    reproduction: reproduction.map((r) => ({
      item_ref: r.item_ref,
      reproduced: r.record.reproduced,
      reachable: r.record.reachable,
      critical: isCritical(r),
      detail: r.record.detail,
    })),
    relevance_quorum: relevanceQuorum,
    relevance_provenance: relevanceProvenance,
    evidence_verified,
    authoritative,
    claim_json: input.claim_json,
    ts: input.ts === undefined ? Date.now() : input.ts,
  };
}
