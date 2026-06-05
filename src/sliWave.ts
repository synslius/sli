// src/sliWave.ts — Phase 3 (DI orchestrator: S1 + S2 + assembler)
//
// KEY DESIGN CLARIFICATION (overrides §3 wording that implies the orchestration
// sandbox imports ablesyn): sliWave is a STANDALONE, dependency-injected
// orchestrator — a normal importable Node/TS module, NOT code running inside the
// Dynamic Workflow sandbox. It takes an injectable `dispatch(prompt, schema) =>
// Promise<object>` for spawning worker/judge agents, so it is testable with a
// FAKE dispatch returning canned claims. Because it runs as a normal module, S2
// calls adjudicate() IMPORTED DIRECTLY from ablesyn — not via a JSON-runner-in-
// agent. (src/adjudicate.mjs remains a thin bridge artifact for the future
// Slice-1 workflow-embed path.)

import { adjudicate, type Adjudication } from "ablesyn";
import {
  buildProofWheel,
  type ProofWheel,
  type ReproductionItem,
  type RelevanceProvenance,
} from "./proofwheel.ts";
import { parsePointer, reproduce, type EvidencePointer, type SandboxOptions } from "./pointer.ts";
import { relevanceQuorum, type RelevanceItem } from "./relevance.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The injected agent dispatcher. Given a prompt + the ABLE schema, it spawns a
 * worker (or judge) and returns its parsed JSON object. In production this wraps
 * a real schema-forced LLM call; in tests it is a fake returning canned claims.
 */
export type Dispatch = (prompt: string, schema: unknown) => Promise<unknown>;

/**
 * A single evidence item as the wave sees it (the raw worker-emitted evidence
 * object), passed to the criticality policy. NOTE: any worker-emitted
 * `critical`/`advisory` field on this object is IGNORED by the wave — caller
 * policy decides criticality (codex P0-2).
 */
export interface WaveEvidenceItem {
  kind: string;
  args: string[];
  pointer?: unknown;
  /** Raw worker object (a worker `critical`/`advisory` field, if any, lives here and is IGNORED). */
  raw: Record<string, unknown>;
}

/**
 * CODE-level criticality policy (codex P0-2). Decided by the WAVE CONFIG /
 * caller policy, NEVER by a worker-emitted field. Returns true if the evidence
 * item is CRITICAL (failing it fails the gate), false if ADVISORY (recorded in
 * the receipt but does not fail the gate). Default: every observed/external
 * item is CRITICAL.
 */
export type CriticalityPolicy<Item> = (
  pointer: EvidencePointer | null,
  item: WaveEvidenceItem,
  claim: Record<string, unknown>,
  waveItem: Item,
) => boolean;

export interface SliWaveOptions<Item> {
  /** Builds the worker prompt for an item. */
  work: (item: Item) => string;
  /** The ABLE schema passed to dispatch (schema-forced worker output). */
  ableSchema: unknown;
  /** Injected agent dispatcher (worker spawner). */
  dispatch: Dispatch;
  /** Wave 2: false (default) runs the structural path end-to-end. */
  verifyEvidence?: boolean;
  /**
   * DEFAULT true (spec §4.4 round-3 P1): never return a "PASS" survivor when
   * verifyEvidence is off — structural-only passes surface as PASS_UNVERIFIED.
   */
  authorityRequired?: boolean;
  /** Byte-bound chunking knob (assembler-level; reserved for S2-via-file path). */
  maxBatchBytes?: number;
  /** Default layer recorded on the receipt when the claim omits one. */
  layer?: string;

  // --- verifyEvidence:true (Wave 3 / Phase 4) knobs ---------------------------

  /**
   * Repo root the S3a reproducer resolves file/command pointers under (sandbox
   * containment). REQUIRED when verifyEvidence:true.
   */
  repoRoot?: string;
  /**
   * S3b independent judge dispatcher. Defaults to `dispatch`. Pass a SEPARATE
   * dispatcher to keep judges out of the worker's blast radius. Judges receive
   * ONLY {assertion, pointer, criterion, detail} — never worker prose.
   */
  relevanceDispatch?: Dispatch;
  /** S3b independent judge count; quorum passes on unanimity. Default 2 (spec). */
  relevanceQuorum?: number;
  /**
   * CODE-level criticality policy (codex P0-2). Default: every observed/external
   * item is CRITICAL. A worker-emitted 'critical'/'advisory' field is IGNORED.
   */
  criticality?: CriticalityPolicy<Item>;
  /** Sandbox knobs forwarded to the S3a reproducer (timeout / output cap). */
  sandboxOptions?: SandboxOptions;
}

export interface SliWaveResult<Item> {
  item: Item;
  /** Positional SLI-assigned key — NEVER the worker claim_id. */
  wave_key: string;
  receipt: ProofWheel;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function claimIdOf(claim: unknown): string | undefined {
  if (isPlainObject(claim) && typeof claim.id === "string") return claim.id;
  return undefined;
}

function assertionOf(claim: unknown): string {
  if (isPlainObject(claim) && typeof claim.assertion === "string") return claim.assertion;
  return "";
}

function layerOf(claim: unknown, fallback: string): string {
  if (isPlainObject(claim) && typeof claim.layer === "string") return claim.layer;
  return fallback;
}

/** Evidence kinds that MUST carry a reproducible pointer (spec §4.2). */
const POINTER_BEARING_KINDS = new Set(["observed", "external"]);

/**
 * Extract the observed/external evidence items from a raw worker claim. Each
 * carries its raw object so the criticality policy can inspect it — but any
 * worker `critical`/`advisory` field is NEVER consulted by the wave (codex P0-2).
 */
function pointerBearingEvidence(claim: Record<string, unknown>): WaveEvidenceItem[] {
  const ev = claim.evidence;
  if (!Array.isArray(ev)) return [];
  const out: WaveEvidenceItem[] = [];
  for (const entry of ev) {
    if (!isPlainObject(entry)) continue;
    const kind = typeof entry.kind === "string" ? entry.kind : "";
    if (!POINTER_BEARING_KINDS.has(kind)) continue;
    const args = Array.isArray(entry.args)
      ? entry.args.filter((a): a is string => typeof a === "string")
      : [];
    out.push({ kind, args, pointer: entry.pointer, raw: entry });
  }
  return out;
}

/** A BLOCK Adjudication synthesized by the SLI assembler (fail-closed). */
function blockAdjudication(code: string, message: string): Adjudication {
  return {
    claim_id: "",
    verdict_claimed: "BLOCK",
    verdict_adjudicated: "BLOCK",
    rules_fired: [{ code, severity: "error", message }],
    ok: false,
    hard_structural: true,
  };
}

// ---------------------------------------------------------------------------
// sliWave
// ---------------------------------------------------------------------------

export async function sliWave<Item>(
  items: Item[],
  opts: SliWaveOptions<Item>,
): Promise<SliWaveResult<Item>[]> {
  const verifyEvidence = opts.verifyEvidence ?? false;
  const authorityRequired = opts.authorityRequired ?? true;
  const layerFallback = opts.layer ?? "BEHAVIOR";
  const repoRoot = opts.repoRoot;
  const sandboxOptions = opts.sandboxOptions;

  // Validate the quorum config ONCE at entry (codex P3-a) so a bad config fails
  // consistently rather than only inside relevanceQuorum() when the judge set is
  // non-empty. relevanceQuorum() applies the same check, but a wave with no
  // critical reproduced items would otherwise never surface the error.
  if (opts.relevanceQuorum !== undefined) {
    if (!Number.isInteger(opts.relevanceQuorum) || opts.relevanceQuorum < 1) {
      throw new Error(
        `sliWave: relevanceQuorum must be an integer >= 1, got ${opts.relevanceQuorum}`,
      );
    }
  }
  // Default criticality policy (codex P0-2): every observed/external item is
  // CRITICAL. A worker-emitted 'critical'/'advisory' field is NEVER consulted.
  const criticality: CriticalityPolicy<Item> = opts.criticality ?? (() => true);

  // S1 — workers (parallel). Each dispatch returns a (canned, in tests) claim.
  // We tolerate per-item dispatch rejection: a thrown/rejected dispatch maps to
  // a missing claim (fail-closed → BLOCK at the assembler).
  const claims: unknown[] = await Promise.all(
    items.map(async (item) => {
      try {
        return await opts.dispatch(opts.work(item), opts.ableSchema);
      } catch {
        return undefined;
      }
    }),
  );

  // Detect duplicate claim_ids across the batch (cross-wire hazard). Any
  // claim_id appearing more than once → all its occurrences are MALFORMED_CLAIM
  // → BLOCK (never silently cross-wire). undefined ids are exempt (handled as
  // missing below).
  const idCounts = new Map<string, number>();
  for (const claim of claims) {
    const id = claimIdOf(claim);
    if (id !== undefined) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  const duplicateIds = new Set<string>();
  for (const [id, n] of idCounts) {
    if (n > 1) duplicateIds.add(id);
  }

  // S2 + assembler — association is POSITIONAL (wave_key = index), NEVER the
  // worker claim_id. This is the anti-cross-wire invariant.
  const results: SliWaveResult<Item>[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const wave_key = `wave_${i}`;
    const claim = claims[i];

    let adjudication: Adjudication;
    let claimJson: Record<string, unknown>;
    let assertion: string;
    let layer: string;

    const id = claimIdOf(claim);

    if (claim === undefined || claim === null) {
      // Missing / undefined Adjudication source → BLOCK (fail-closed §6 inv 1).
      adjudication = blockAdjudication(
        "MALFORMED_CLAIM",
        "worker dispatch returned no claim (missing/undefined) — fail-closed BLOCK",
      );
      claimJson = {};
      assertion = "";
      layer = layerFallback;
    } else if (!isPlainObject(claim)) {
      adjudication = blockAdjudication(
        "MALFORMED_CLAIM",
        "worker dispatch returned a non-object claim — fail-closed BLOCK",
      );
      claimJson = {};
      assertion = "";
      layer = layerFallback;
    } else if (id !== undefined && duplicateIds.has(id)) {
      // Duplicate claim_id in the batch → BLOCK this occurrence (no cross-wire).
      adjudication = {
        ...blockAdjudication(
          "MALFORMED_CLAIM",
          `duplicate claim_id ${JSON.stringify(id)} in batch — fail-closed BLOCK (no cross-wire)`,
        ),
        claim_id: id,
      };
      claimJson = claim;
      assertion = assertionOf(claim);
      layer = layerOf(claim, layerFallback);
    } else {
      // S2: adjudicate IMPORTED DIRECTLY from ablesyn (mechanical, deterministic).
      adjudication = adjudicate(claim);
      claimJson = claim;
      assertion = assertionOf(claim);
      layer = layerOf(claim, layerFallback);
    }

    // S3 (verifyEvidence:true) — Wave 3 wires the full S3a → S3b → S4-derive
    // path. S3 runs ONLY for a non-BLOCK claim carrying observed/external
    // evidence; on a BLOCK claim it is skipped (s3Ran stays false →
    // evidence_verified:null → never authoritative).
    let s3Ran = false;
    let reproductionItems: ReproductionItem[] | undefined;
    let relevanceQuorumOutcome: boolean | null | undefined;
    let relevanceProvenance: RelevanceProvenance | null = null;

    if (verifyEvidence && adjudication.verdict_adjudicated !== "BLOCK") {
      const evItems = pointerBearingEvidence(claimJson);
      if (evItems.length > 0) {
        if (repoRoot === undefined) {
          throw new Error(
            "sliWave: verifyEvidence:true requires opts.repoRoot for the S3a reproducer sandbox",
          );
        }
        s3Ran = true;

        // S3a — deterministic reproduction per item + CODE-level criticality.
        // A worker-emitted 'critical'/'advisory' field is NEVER consulted: the
        // caller policy (or the default: every observed/external item CRITICAL)
        // decides. A pointerless item is non-reproducible (spec §4.2).
        const repros: ReproductionItem[] = [];
        const typedPointers: (EvidencePointer | null)[] = [];
        for (let e = 0; e < evItems.length; e++) {
          const evItem = evItems[e]!;
          const item_ref = `e${e}`;

          // Parse the pointer (if any) so the criticality policy + S3b judge see
          // a typed pointer; a pointerless / unparseable pointer → null pointer.
          let typedPointer: EvidencePointer | null = null;
          if (evItem.pointer !== undefined) {
            const parsed = parsePointer(evItem.pointer);
            if (parsed.ok) typedPointer = parsed.pointer;
          }
          typedPointers.push(typedPointer);

          // S3a record. A pointerless observed/external item is non-reproducible
          // (reproduce() on undefined → parse error → reproduced:false,
          // reachable:false), so it can never become authoritative.
          const record = reproduce(evItem.pointer, repoRoot, sandboxOptions);

          const critical = criticality(typedPointer, evItem, claimJson, item);
          repros.push({ item_ref, record, critical });
        }
        reproductionItems = repros;

        // S3b — relevance quorum over the CRITICAL, REPRODUCED items ONLY.
        // (Advisory items never gate; unreproduced items are already rejected by
        // proofwheel's derivation, and judging them would be meaningless — so a
        // judge is never even ASKED about an unreproduced item: relevance is
        // strictly gate-only and cannot self-upgrade.)
        const toJudge: RelevanceItem[] = [];
        for (let e = 0; e < repros.length; e++) {
          const r = repros[e]!;
          const typedPointer = typedPointers[e]!;
          // A reproduced critical item always has a parseable pointer (it was
          // reproduced), but guard defensively against a null pointer.
          if (r.critical !== false && r.record.reproduced === true && typedPointer !== null) {
            toJudge.push({
              item_ref: r.item_ref,
              assertion, // prose-free proposition; NEVER worker verdict/belief prose
              pointer: typedPointer,
              criterion: typedPointer.mustMatch,
              detail: r.record.detail,
            });
          }
        }

        const quorumResult = await relevanceQuorum(toJudge, {
          quorum: opts.relevanceQuorum ?? 2,
          dispatch: opts.relevanceDispatch ?? opts.dispatch,
        });
        relevanceQuorumOutcome = quorumResult.quorum;
        relevanceProvenance = quorumResult.provenance;
      }
    }

    // S4 — structural receipt. When S3 ran, proofwheel CODE-derives
    // evidence_verified over CRITICAL items only + promotes PASS_UNVERIFIED→PASS
    // only when evidence_verified===true.
    const receipt = buildProofWheel({
      wave_key,
      adjudication,
      claim_json: claimJson,
      assertion,
      layer,
      s3Ran,
      reproduction: reproductionItems,
      relevanceQuorum: relevanceQuorumOutcome,
      relevanceProvenance,
      ts: null, // deterministic receipts in the standalone path
    });

    // authorityRequired:true (default) — invariant assertion: with S3 off, no
    // receipt may claim authority. (PASS_UNVERIFIED is never authoritative.)
    if (authorityRequired && !s3Ran && receipt.authoritative) {
      throw new Error(
        `sliWave invariant violated: authoritative PASS leaked without verification (wave_key=${wave_key})`,
      );
    }

    results.push({ item, wave_key, receipt });
  }

  return results;
}
