// src/pointer.ts — Phase 2
//
// EvidencePointer + REQUIRED typed criterion + closed read-only command sandbox
// + S3a deterministic reproducer.
//
// Design refs: spec §4.4 (EvidencePointer + REQUIRED success criterion;
// command sandbox), §5 Proof A′/A″/A‴/B, §6 invariant 4 (sandbox is a
// mechanism). codex review carry-ins: P1-3 (criterion is TYPED — never a bare
// ambiguous string; a command pointer with NO output criterion is REJECTED) and
// P2-3 (CLOSED read-only command sandbox).
//
// This module is mechanical and dependency-free (no ablesyn, no LLM). Same
// input → same record (determinism, §6 invariant 5).

import {
  existsSync,
  realpathSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { isAbsolute, resolve as pathResolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A typed match criterion. NEVER a bare ambiguous string (codex P1-3). */
export type MatchCriterion =
  | { kind: "regex"; value: string; flags?: string }
  | { kind: "substring"; value: string }
  // "empty" is only meaningful for command pointers: assert the command
  // produced no (non-whitespace) output. `value` is unused.
  | { kind: "empty" };

export type FilePointer = {
  type: "file";
  path: string;
  // file pointers must match by content; "empty" is not a file criterion.
  mustMatch: { kind: "regex"; value: string; flags?: string } | { kind: "substring"; value: string };
  lineHint?: [number, number];
};

export type CommandPointer = {
  type: "command";
  // The command string. KNOWN LIMITATIONS (documented, not bugs — no current
  // proof depends on either, and both fail safe):
  //   1. Args are whitespace-split with NO quoting support (validateCommand
  //      splits on /\s+/). A single arg that must contain a space (e.g. a grep
  //      pattern with a literal space) cannot be expressed; it would split into
  //      two argv tokens. All shell metachars (incl. quotes via $ and `) are
  //      already rejected, so this is a usability gap, not a soundness hole.
  //   2. The grep/path-containment check in reproduceCommand can OVER-reject: a
  //      non-path arg that happens to contain "/" (e.g. a regex like "a/b") is
  //      routed through resolveUnderRoot and may be rejected as a path escape.
  //      This is fail-closed (safe): the pointer becomes non-reproducible, never
  //      a false PASS.
  cmd: string;
  expectExit: number;
  // criterion REQUIRED (codex P1-3): a command pointer with NO output criterion
  // is rejected. The "empty" kind asserts the command produced no output.
  mustMatch: MatchCriterion;
};

export type EvidencePointer = FilePointer | CommandPointer;

export type PointerParse =
  | { ok: true; pointer: EvidencePointer }
  | { ok: false; error: string };

export interface ReproRecord {
  reproduced: boolean;
  reachable: boolean;
  detail: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Sandbox policy
// ---------------------------------------------------------------------------

/**
 * Closed read-only command HEAD allowlist (codex P2-3). Only the listed first
 * tokens may begin a command. Everything else is rejected before execution.
 */
export const COMMAND_HEAD_ALLOWLIST: ReadonlySet<string> = new Set([
  "git",
  "grep",
  "rg",
  "cat",
  "test",
  "ls",
]);

/**
 * Read-only `git` SUBCOMMAND allowlist (S1). The head-allowlist only checks
 * argv[0]; without a subcommand gate a MUTATING git subcommand (init, reset,
 * clean, checkout, rm, stash, commit, add, fetch, pull, push, merge, branch,
 * gc, tag, …) would run under repoRoot and destroy state (VERIFIED: `git clean
 * -fd` deleted an untracked file; `git reset --hard` destroyed uncommitted work;
 * `git init` created .git). So when head==="git" we require argv[1] to be one of
 * these strictly read-only subcommands; everything else (and a bare `git` with
 * NO subcommand) is rejected before execution.
 */
export const GIT_READONLY_SUBCOMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  "log",
  "show",
  "status",
  "diff",
  "cat-file",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "blame",
  "grep",
  "describe",
  "for-each-ref",
  "show-ref",
  "symbolic-ref",
]);

/**
 * `git` GLOBAL flags (the ones that appear BEFORE the subcommand) that take
 * their value as a SEPARATE next token (`-C status`, `--git-dir foo`). When the
 * subcommand scanner hits one of these it MUST skip the next token too — that
 * token is the flag's VALUE, never a subcommand (S1). Attached forms carry
 * their own value (`-Cstatus`, `--git-dir=foo`, `-cx=y`) and consume nothing
 * extra. Without this, `git -C status clean` reads `status` (the -C VALUE) as
 * the subcommand and lets the mutating `clean` through.
 */
const GIT_GLOBAL_VALUE_SHORT: ReadonlySet<string> = new Set(["-C", "-c"]);
const GIT_GLOBAL_VALUE_LONG: ReadonlySet<string> = new Set([
  "--git-dir",
  "--work-tree",
  "--exec-path",
  "--namespace",
  "--super-prefix",
]);

/**
 * Locate the git subcommand token, consuming the VALUES of separate-form
 * value-taking global flags so a value can never be mis-read as the subcommand
 * (S1). Returns the first genuine non-flag token, or undefined for bare `git`.
 */
function findGitSubcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (!tok.startsWith("-")) {
      return tok; // first genuine non-flag token is the subcommand
    }
    // It's a flag. If it is a SEPARATE-form value-taking global flag (the exact
    // bare flag, no `=` / no attached value), the NEXT token is its value — skip
    // it so it can't be read as the subcommand.
    if (tok.startsWith("--")) {
      // Attached long form `--git-dir=path` carries its own value → no skip.
      if (!tok.includes("=") && GIT_GLOBAL_VALUE_LONG.has(tok)) {
        i++; // consume the separate value token
      }
    } else {
      // Short form. Exact `-C` / `-c` (length 2) takes a separate value; an
      // attached `-Cpath` / `-cx=y` (length > 2) carries its own value → no skip.
      if (tok.length === 2 && GIT_GLOBAL_VALUE_SHORT.has(tok)) {
        i++; // consume the separate value token
      }
    }
  }
  return undefined;
}

/**
 * Shell metacharacters that mutate, network, chain, redirect, or substitute.
 * Any occurrence in a command string → rejected. We never invoke a shell
 * (spawnSync with shell:false), but we still reject these so a metachar can
 * never be smuggled as a literal argv token that a future change might shell out.
 */
const FORBIDDEN_METACHARS: readonly string[] = [
  ">",
  "<",
  "|",
  ";",
  "&",
  "$",
  "`",
  "(",
  ")",
  "{",
  "}",
  "\n",
  "\r",
  "*",
  "?",
  "~",
  "\\",
];

/**
 * Symlink-following / recursive-dereference `grep` flags banned outright (S4).
 * GNU/BSD `grep -R` (and `-S`/`--dereference-recursive`/`--dereference`/`-O`/
 * `--dereference-argument`) follows symlinks, so a recursive grep can read an
 * external symlink target OUTSIDE repoRoot (VERIFIED: `grep -RS .` read an
 * external symlink target). grep does NOT get a per-arg realpath gate strong
 * enough to defeat in-tree symlinks during recursion, so we reject the
 * symlink-following recursive flags entirely. RECURSIVE directory search should
 * go through `rg` (ripgrep does NOT follow symlinks by default), which is the
 * preferred path for recursive reads in this sandbox.
 *
 * NOTE: plain `-r`/`--recursive` (no symlink deref) is also rejected here as a
 * conservative fail-closed stance — recursion belongs to `rg`. Single-file grep
 * (the common pointer shape) is unaffected.
 */
export const GREP_FORBIDDEN_RECURSIVE_FLAGS: ReadonlySet<string> = new Set([
  "-R",
  "-r",
  "-S",
  "--recursive",
  "--dereference-recursive",
  "--dereference",
  "-O",
  "--dereference-argument",
  // `--directories=recurse` / `-d recurse` make grep recurse the same way `-r`
  // does (GNU). codex flagged these as parse-gaps: on BSD/GNU they don't widen
  // the escape beyond `-r` (already banned), but we reject them anyway so the
  // screen is HONEST about what it covers (defense-in-depth, not a live hole).
  "--directories=recurse",
]);

/**
 * Symlink-following `rg` (ripgrep) flags banned outright (S4). ripgrep does NOT
 * follow symlinks by default — that is why recursion is steered to `rg` — but
 * `--follow` / `-L` re-enables symlink traversal, so an in-root symlink whose
 * realpath is OUTSIDE repoRoot becomes readable again (VERIFIED: `rg --follow
 * MARKER .` read a file resolving outside the root). Reject the long flag, its
 * short alias `-L`, and any bundled short cluster containing `L` (e.g. `-Ln`).
 */
export const RG_FORBIDDEN_SYMLINK_FLAGS: ReadonlySet<string> = new Set([
  "--follow",
  "-L",
]);

/**
 * PATH-BEARING flags per head (S2). These flags take a filesystem path as their
 * value and so can REDIRECT a read outside repoRoot if not contained (VERIFIED:
 * `git --git-dir=../external/.git show HEAD:secret.txt` read OUTSIDE repoRoot).
 * The containment loop in reproduceCommand must NOT blanket-skip `-`-prefixed
 * args: for these flags it extracts the path value (attached `--git-dir=PATH` /
 * `-fPATH`, or the following separate token `-f PATH`) and routes it through
 * resolveUnderRoot, rejecting any value that escapes the root. Genuinely
 * path-free flags (`-n`, `-i`, `--oneline`, …) are still skipped.
 *
 * `long`  — long-form flags whose value is a path (attached via `=` or the next
 *           token).
 * `short` — single-dash short flags whose value is a path (attached as `-fPATH`
 *           or the next token `-f PATH`).
 */
const PATH_BEARING_FLAGS: Record<string, { long: ReadonlySet<string>; short: ReadonlySet<string> }> = {
  git: {
    long: new Set(["--git-dir", "--work-tree", "--exec-path", "--output", "--output-directory"]),
    short: new Set(["-C", "-o"]),
  },
  grep: { long: new Set(["--file"]), short: new Set(["-f"]) },
  rg: { long: new Set(["--file"]), short: new Set(["-f"]) },
};

/**
 * True if a flag's VALUE looks like a filesystem path that must be CONTAINED
 * under repoRoot (S2). The enumerated PATH_BEARING_FLAGS list is a fast-path
 * HINT, not the gate — it is open-ended (a read-only subcommand can grow a new
 * `--output=`-style path flag at any time, e.g. `git diff --output=../x` WROTE
 * outside the root via an allowlisted subcommand because `--output` was not
 * enumerated). So the REAL gate is value-based: ANY flag value that contains a
 * path separator, starts with `..`, or resolves to an existing path under the
 * root is treated as a path and routed through resolveUnderRoot. Genuinely
 * path-free values (`oneline`, `5`, `recurse`) contain no separator → pass.
 */
function looksLikePath(realRoot: string, value: string): boolean {
  if (value.length === 0) return false;
  if (value.includes("/")) return true;
  if (value.startsWith("..")) return true;
  // A bare token that names an existing entry under the root (e.g. a relative
  // filename with no slash) is also a path we should contain.
  if (existsSync(pathResolve(realRoot, value))) return true;
  return false;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000; // 1 MB cap
/**
 * Cap on the file BYTES read by reproduceFile (mirrors the command-path output
 * cap so a 2 GB file can't be slurped whole). On overflow the file is read
 * truncated and the reproduction is marked tooLarge / truncated so a partial
 * match can never masquerade as a full-content match (codex P2-2).
 */
const DEFAULT_MAX_FILE_BYTES = DEFAULT_MAX_OUTPUT_BYTES; // 1 MB cap
/**
 * Cap on the TEXT length handed to a worker-supplied RegExp#test (codex P2-1).
 * Combined with the nested-unbounded-quantifier rejection at parse time, this
 * bounds the worst-case backtracking work: the distrusted worker can neither
 * ship a catastrophic pattern (rejected) nor feed an unbounded-length input.
 */
const DEFAULT_MAX_REGEX_TEST_CHARS = 100_000;

export interface SandboxOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxFileBytes?: number;
}

// ---------------------------------------------------------------------------
// parsePointer — validate + return typed pointer or a parse error.
// Unparseable → non-reproducible (caller records reproduced:false).
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type RegexCriterion = { kind: "regex"; value: string; flags?: string };

/**
 * Reject regex patterns prone to CATASTROPHIC backtracking (codex P2-1). The
 * worker is the DISTRUSTED party emitting `mustMatch.value`, and a pattern like
 * `(a+)+$` against a non-matching 40-char input pins the engine for hundreds of
 * ms (and on a naive backtracking engine, minutes). Rather than add a native
 * linear-time engine (would break the dependency-free property) or a per-match
 * worker_thread (latency + spawn-failure surface on every reproduction), we
 * reject the dangerous shape at its entry point. The catastrophic-backtracking
 * roots screened here are:
 *   1. an ambiguity-multiplying quantifier (`*`, `+`, `{n,}`, OR `?`) applied to
 *      a group whose body ITSELF contains an unbounded quantifier — e.g.
 *      `(a+)+`, `(a*)*`, `([a-z]+)*`, and (S6) `(a*)?b`;
 *   2. an ambiguity-multiplying quantifier applied to a group whose body
 *      contains a top-level ALTERNATION — e.g. `(a|a)+`, `(a|ab)*`
 *      (overlapping/ambiguous alternatives multiply the backtracking paths);
 *   3. (S6) an UNBOUNDED quantifier (`*`, `+`, `{n,}`) applied to a group whose
 *      body contains an OPTIONAL `?` — e.g. `(a?)+b`, `(a?)*b`, `([a-z]?)+9`. A
 *      `?` inside the body makes the body ambiguous-empty-matchable, so an outer
 *      unbounded repeat of an empty-matchable body explodes the backtracking
 *      paths exactly like a nested unbounded quantifier does.
 * Rejecting these shapes (plus the input-length cap in `matches`) bounds the
 * worst case to a small, measured budget.
 *
 * This is a deliberately conservative STRUCTURAL screen, not a full RE
 * analyzer: it can over-reject an exotic-but-safe pattern (fail-closed — the
 * pointer simply becomes non-reproducible, never a false PASS), and it does not
 * claim to catch every catastrophic family. The input-length cap is the
 * defense-in-depth second line that bounds anything the screen misses.
 */
function hasNestedUnboundedQuantifier(src: string): boolean {
  // Walk the pattern tracking group nesting. For each group we record whether
  // its BODY contains an unbounded quantifier, a top-level alternation, OR an
  // optional `?` (S6 — `?` makes the body ambiguous-empty-matchable). If such a
  // group is then itself ambiguity-multiplying-quantified, that is the
  // catastrophic shape.
  type Frame = {
    bodyHasUnbounded: boolean;
    bodyHasAlternation: boolean;
    bodyHasOptional: boolean;
  };
  const stack: Frame[] = [];
  let inClass = false; // inside a [...] character class
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      i++; // skip the escaped char (it is a literal, never a quantifier/group)
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      stack.push({ bodyHasUnbounded: false, bodyHasAlternation: false, bodyHasOptional: false });
      // S6(b) — consume a SPECIAL-GROUP prefix so its `?` is never counted as a
      // body optional. `(?:…)` non-capture, `(?=…)`/`(?!…)` look-ahead,
      // `(?<=…)`/`(?<!…)` look-behind, `(?<name>…)` named group all begin with a
      // `?` that is GROUP SYNTAX, not a `?` quantifier on the body. Without this,
      // a SAFE `(?:ab)+c` / `(?<name>ab)+c` is wrongly REJECTED (W7 regression)
      // because the prefix `?` marked bodyHasOptional. Advance `i` past the
      // prefix chars so the main loop never sees them.
      if (src[i + 1] === "?") {
        const after = src[i + 2];
        if (after === ":" || after === "=" || after === "!") {
          i += 2; // skip `?` and the `:`/`=`/`!`
        } else if (after === "<") {
          const after2 = src[i + 3];
          if (after2 === "=" || after2 === "!") {
            i += 3; // look-behind `(?<=` / `(?<!`
          } else {
            // Named group `(?<name>…)` — skip up to and including the `>`.
            const gt = src.indexOf(">", i + 3);
            i = gt === -1 ? src.length : gt;
          }
        } else {
          // A bare `(?` with no recognized prefix char (e.g. inline flags
          // `(?i)`): just skip the `?` so it isn't a body optional marker.
          i += 1;
        }
      }
      continue;
    }
    if (c === "|") {
      // A top-level alternation inside the current group.
      if (stack.length > 0) stack[stack.length - 1]!.bodyHasAlternation = true;
      continue;
    }
    if (c === ")") {
      const frame = stack.pop();
      // Look at the quantifier (if any) applied to THIS group.
      const next = src[i + 1];
      const groupQuantUnbounded =
        next === "*" ||
        next === "+" ||
        (next === "{" && isUnboundedBraceQuantifier(src, i + 1));
      // S6 — an OPTIONAL `?` on the group is also ambiguity-multiplying: it lets
      // the whole (possibly unbounded-matching) body be skipped, so e.g.
      // `(a*)?b` explodes the same way `(a+)+b` does.
      const groupQuantOptional = next === "?";
      const groupQuantAmbiguous = groupQuantUnbounded || groupQuantOptional;
      if (
        frame &&
        (frame.bodyHasUnbounded || frame.bodyHasAlternation || frame.bodyHasOptional) &&
        groupQuantAmbiguous
      ) {
        // (…unbounded…|alternation…|optional…)<unbounded|optional> → catastrophic.
        // Covers (a+)+, (a|a)*, (a?)+b, (a?)*b, ([a-z]?)+9, and (a*)?b.
        return true;
      }
      // S6(a) — PROPAGATE the popped inner frame's facts into the PARENT so a
      // WRAPPING group inherits the danger. Without this, the inner group's facts
      // died on pop and `((a+))+b` / `((a?))+b` / `((a*))?b` SLIPPED (the outer
      // group's body looked fact-free even though it wraps a dangerous inner
      // group — genuinely catastrophic on V8: ((a+))+b ≈ 429ms, ((a*))*b ≈
      // 1090ms). We OR the inner body facts into the parent body, AND record THIS
      // group's OWN quantifier (optional/unbounded) as a parent-body fact so a
      // further-out wrapper also inherits.
      if (frame && stack.length > 0) {
        const parent = stack[stack.length - 1]!;
        parent.bodyHasUnbounded = parent.bodyHasUnbounded || frame.bodyHasUnbounded;
        parent.bodyHasAlternation = parent.bodyHasAlternation || frame.bodyHasAlternation;
        parent.bodyHasOptional = parent.bodyHasOptional || frame.bodyHasOptional;
        if (groupQuantUnbounded) parent.bodyHasUnbounded = true;
        if (groupQuantOptional) parent.bodyHasOptional = true;
      }
      continue;
    }
    // An OPTIONAL `?` anywhere marks the enclosing group's body as
    // ambiguous-empty-matchable (S6). Skip a `?` that is itself the group
    // quantifier — that is handled at `)` above, not as a body marker — but a
    // `?` NOT immediately after a `)` (e.g. the `?` in `(a?)`) marks the body.
    if (c === "?" && stack.length > 0 && src[i - 1] !== ")") {
      stack[stack.length - 1]!.bodyHasOptional = true;
    }
    // An unbounded quantifier anywhere marks the enclosing group's body.
    const unbounded =
      c === "*" || c === "+" || (c === "{" && isUnboundedBraceQuantifier(src, i));
    if (unbounded && stack.length > 0) {
      stack[stack.length - 1]!.bodyHasUnbounded = true;
    }
  }
  return false;
}

/** True if the `{...}` starting at `src[open]` is an unbounded `{n,}` form. */
function isUnboundedBraceQuantifier(src: string, open: number): boolean {
  const close = src.indexOf("}", open);
  if (close === -1) return false;
  const body = src.slice(open + 1, close);
  // `{n,}` (no upper bound) is unbounded; `{n}` and `{n,m}` are bounded.
  return /^\d+,$/.test(body);
}

/**
 * Parse a typed `regex` criterion (shared by file + command pointers). The only
 * difference between the two call-sites is whether an empty pattern is rejected:
 * a command criterion must be non-empty (an empty pattern matches everything →
 * the "no real criterion" cheat), whereas a file regex may legitimately be empty.
 */
function parseRegexCriterion(
  raw: Record<string, unknown>,
  rejectEmpty: { error: string } | null,
): { ok: true; value: RegexCriterion } | { ok: false; error: string } {
  if (typeof raw.value !== "string") {
    return { ok: false, error: "regex criterion requires a string value" };
  }
  if (rejectEmpty && raw.value.length === 0) {
    return { ok: false, error: rejectEmpty.error };
  }
  if (raw.flags !== undefined && typeof raw.flags !== "string") {
    return { ok: false, error: "regex criterion flags must be a string" };
  }
  // Validate the regex compiles deterministically; a bad pattern → parse error.
  try {
    new RegExp(raw.value, typeof raw.flags === "string" ? raw.flags : undefined);
  } catch (e) {
    return { ok: false, error: `invalid regex: ${(e as Error).message}` };
  }
  // Reject catastrophic-backtracking shapes from the DISTRUSTED worker (codex
  // P2-1): a nested unbounded quantifier like (a+)+ is the classic ReDoS root.
  if (hasNestedUnboundedQuantifier(raw.value)) {
    return {
      ok: false,
      error:
        "regex criterion rejected: nested unbounded quantifier (catastrophic-backtracking risk)",
    };
  }
  return {
    ok: true,
    value:
      typeof raw.flags === "string"
        ? { kind: "regex", value: raw.value, flags: raw.flags }
        : { kind: "regex", value: raw.value },
  };
}

function parseFileCriterion(
  raw: unknown,
): { ok: true; value: FilePointer["mustMatch"] } | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "file pointer mustMatch must be a typed criterion object" };
  }
  const kind = raw.kind;
  if (kind === "regex") {
    return parseRegexCriterion(raw, null);
  }
  if (kind === "substring") {
    if (typeof raw.value !== "string") {
      return { ok: false, error: "substring criterion requires a string value" };
    }
    return { ok: true, value: { kind: "substring", value: raw.value } };
  }
  return { ok: false, error: `file pointer criterion kind must be "regex" or "substring", got ${JSON.stringify(kind)}` };
}

function parseCommandCriterion(
  raw: unknown,
): { ok: true; value: MatchCriterion } | { ok: false; error: string } {
  // codex P1-3: criterion REQUIRED — a missing/absent criterion is rejected.
  if (raw === undefined || raw === null) {
    return { ok: false, error: "command pointer requires a typed mustMatch criterion (none given)" };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, error: "command pointer mustMatch must be a typed criterion object" };
  }
  const kind = raw.kind;
  if (kind === "empty") {
    return { ok: true, value: { kind: "empty" } };
  }
  if (kind === "regex") {
    return parseRegexCriterion(raw, { error: "command pointer regex criterion must be non-empty" });
  }
  if (kind === "substring") {
    if (typeof raw.value !== "string") {
      return { ok: false, error: "substring criterion requires a string value" };
    }
    if (raw.value.length === 0) {
      // An empty substring matches everything → that is the "no real criterion"
      // cheat. Reject it; use the explicit "empty" kind to assert no output.
      return { ok: false, error: "command pointer substring criterion must be non-empty (use kind:empty to assert no output)" };
    }
    return { ok: true, value: { kind: "substring", value: raw.value } };
  }
  return {
    ok: false,
    error: `command pointer criterion kind must be "regex" | "substring" | "empty", got ${JSON.stringify(kind)}`,
  };
}

export function parsePointer(raw: unknown): PointerParse {
  // S5 — `raw` is WORKER-CONTROLLED; any property read below (`raw.type`,
  // `raw.path`, `raw.cmd`, `raw.mustMatch`, …) can be a POISONED getter that
  // throws. parsePointer is called from the S3 hot path (sliWave) where an
  // unguarded throw would reject the whole wave and drop every sibling receipt.
  // Treat a throwing accessor as an UNPARSEABLE pointer (fail-closed → non-
  // reproducible), exactly like any other malformed pointer.
  try {
    return parsePointerInner(raw);
  } catch (e) {
    return { ok: false, error: `pointer property access threw (poisoned getter): ${(e as Error).message}` };
  }
}

function parsePointerInner(raw: unknown): PointerParse {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "pointer must be an object" };
  }
  if (raw.type === "file") {
    if (typeof raw.path !== "string" || raw.path.length === 0) {
      return { ok: false, error: "file pointer requires a non-empty string path" };
    }
    const crit = parseFileCriterion(raw.mustMatch);
    if (!crit.ok) {
      return { ok: false, error: crit.error };
    }
    let lineHint: [number, number] | undefined;
    if (raw.lineHint !== undefined) {
      const lh = raw.lineHint;
      if (
        !Array.isArray(lh) ||
        lh.length !== 2 ||
        typeof lh[0] !== "number" ||
        typeof lh[1] !== "number"
      ) {
        return { ok: false, error: "file pointer lineHint must be [number, number]" };
      }
      lineHint = [lh[0], lh[1]];
    }
    const pointer: FilePointer = { type: "file", path: raw.path, mustMatch: crit.value };
    if (lineHint) pointer.lineHint = lineHint;
    return { ok: true, pointer };
  }
  if (raw.type === "command") {
    if (typeof raw.cmd !== "string" || raw.cmd.length === 0) {
      return { ok: false, error: "command pointer requires a non-empty string cmd" };
    }
    if (typeof raw.expectExit !== "number" || !Number.isInteger(raw.expectExit)) {
      return { ok: false, error: "command pointer requires an integer expectExit" };
    }
    const crit = parseCommandCriterion(raw.mustMatch);
    if (!crit.ok) {
      return { ok: false, error: crit.error };
    }
    // Validate the command head + args up-front so an invalid command is
    // non-reproducible BEFORE execution (spec §4.4).
    const cmdCheck = validateCommand(raw.cmd);
    if (!cmdCheck.ok) {
      return { ok: false, error: cmdCheck.error };
    }
    return {
      ok: true,
      pointer: { type: "command", cmd: raw.cmd, expectExit: raw.expectExit, mustMatch: crit.value },
    };
  }
  return { ok: false, error: `pointer type must be "file" or "command", got ${JSON.stringify(raw.type)}` };
}

// ---------------------------------------------------------------------------
// Command validation — allowlist + metachar + absolute-path rejection.
// ---------------------------------------------------------------------------

export function validateCommand(
  cmd: string,
): { ok: true; argv: string[] } | { ok: false; error: string } {
  for (const meta of FORBIDDEN_METACHARS) {
    if (cmd.includes(meta)) {
      return { ok: false, error: `command contains forbidden shell metacharacter ${JSON.stringify(meta)}` };
    }
  }
  // Whitespace-split is safe here because all metachars (incl quotes via $,`)
  // are already rejected; commands are a head + literal args only.
  const argv = cmd.trim().split(/\s+/).filter((t) => t.length > 0);
  if (argv.length === 0) {
    return { ok: false, error: "command is empty" };
  }
  const head = argv[0]!;
  if (!COMMAND_HEAD_ALLOWLIST.has(head)) {
    return {
      ok: false,
      error: `command head ${JSON.stringify(head)} is not in the read-only allowlist (${[...COMMAND_HEAD_ALLOWLIST].join(", ")})`,
    };
  }
  // S1 — `git` SUBCOMMAND gate. argv[0]==="git" is not enough: a MUTATING
  // subcommand (init/reset/clean/checkout/rm/…) would run under repoRoot and
  // destroy state. Require the first non-flag arg to be a read-only subcommand,
  // and reject `git` with no subcommand at all. (Path-bearing global flags like
  // `--git-dir` are separately routed through resolveUnderRoot in
  // reproduceCommand; here we just locate the subcommand token.)
  //
  // The naive `find(a => !a.startsWith("-"))` is VALUE-BLIND: a separate-form
  // value-taking global flag like `-C status` puts a NON-flag VALUE (`status`)
  // right where the subcommand scanner looks, so `git -C status clean -fd`
  // mis-reads `status` (an allowlisted read-only name) as the subcommand while
  // the REAL mutating `clean` runs under repoRoot/status (VERIFIED: deleted a
  // victim file; `git -C status reset --hard` destroyed uncommitted work). FIX:
  // walk argv from index 1; when a SEPARATE-form value-taking global flag is
  // seen, skip the NEXT token too (it is that flag's value, never a subcommand);
  // attached forms (`-Cpath`, `--git-dir=path`, `-cx=y`) carry their own value
  // and consume nothing extra. The first remaining non-flag token is the real
  // subcommand.
  if (head === "git") {
    const sub = findGitSubcommand(argv.slice(1));
    if (sub === undefined) {
      return { ok: false, error: "git command requires a read-only subcommand (none given)" };
    }
    if (!GIT_READONLY_SUBCOMMAND_ALLOWLIST.has(sub)) {
      return {
        ok: false,
        error: `git subcommand ${JSON.stringify(sub)} is not in the read-only subcommand allowlist (${[...GIT_READONLY_SUBCOMMAND_ALLOWLIST].join(", ")})`,
      };
    }
  }
  // S4 — `grep` symlink-following / recursive-deref flag ban. A recursive grep
  // follows symlinks and can read OUTSIDE repoRoot; recursion belongs to `rg`
  // (no symlink-follow by default). Reject the long-form flags AND any short
  // flag cluster (e.g. `-RS`, `-rn`) containing a banned single-char flag.
  if (head === "grep") {
    const bannedShort = new Set(["R", "r", "S", "O"]);
    const grepArgs = argv.slice(1);
    for (let i = 0; i < grepArgs.length; i++) {
      const arg = grepArgs[i]!;
      if (GREP_FORBIDDEN_RECURSIVE_FLAGS.has(arg)) {
        return { ok: false, error: `grep flag ${JSON.stringify(arg)} follows symlinks / recurses out of repoRoot — use rg for recursive reads` };
      }
      // `-d recurse` / `--directories recurse` (separate-value form) recurses
      // like `-r` (GNU). Reject the recurse mode whether attached or separate.
      if ((arg === "-d" || arg === "--directories") && grepArgs[i + 1] === "recurse") {
        return { ok: false, error: `grep flag ${JSON.stringify(arg + " recurse")} recurses out of repoRoot — use rg for recursive reads` };
      }
      // Bundled short flags: `-RS`, `-rn`, … (a single dash, no `=`, not `--`).
      if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1) {
        for (const ch of arg.slice(1)) {
          if (bannedShort.has(ch)) {
            return { ok: false, error: `grep flag ${JSON.stringify("-" + ch)} (in ${JSON.stringify(arg)}) follows symlinks / recurses out of repoRoot — use rg for recursive reads` };
          }
        }
      }
    }
  }
  // S4 — `rg` symlink-follow ban. ripgrep does not follow symlinks by default
  // (that is why recursion is steered here), but `--follow`/`-L` re-enables it,
  // re-opening the in-root-symlink-to-outside-target escape (VERIFIED: `rg
  // --follow MARKER .` read a file resolving outside the root). Reject the long
  // flag AND any short cluster containing `L` (e.g. `-Ln`).
  if (head === "rg") {
    for (const arg of argv.slice(1)) {
      if (RG_FORBIDDEN_SYMLINK_FLAGS.has(arg)) {
        return { ok: false, error: `rg flag ${JSON.stringify(arg)} follows symlinks out of repoRoot — symlink-following recursive reads are not permitted` };
      }
      // Bundled short flags: `-Ln`, `-nL`, … (single dash, no `=`, not `--`).
      if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1) {
        if (arg.slice(1).includes("L")) {
          return { ok: false, error: `rg flag "-L" (in ${JSON.stringify(arg)}) follows symlinks out of repoRoot — symlink-following recursive reads are not permitted` };
        }
      }
    }
  }
  // Reject absolute paths anywhere in the args (forces all paths under repoRoot).
  for (const arg of argv.slice(1)) {
    if (isAbsolute(arg)) {
      return { ok: false, error: `absolute path not permitted in command arg ${JSON.stringify(arg)}` };
    }
  }
  return { ok: true, argv };
}

// ---------------------------------------------------------------------------
// Path containment — resolve under repoRoot, reject symlink escapes.
// ---------------------------------------------------------------------------

/** True if `child` is `root` itself or strictly within it. */
function isWithin(root: string, child: string): boolean {
  if (child === root) return true;
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return child.startsWith(rootWithSep);
}

/**
 * Resolve a candidate path under repoRoot, following symlinks on whatever
 * prefix exists, and REJECT any resolution that escapes repoRoot. Returns the
 * resolved real path (for an existing target) or the lexical resolved path (for
 * a not-yet-existing target whose existing ancestor is contained).
 */
export function resolveUnderRoot(
  repoRoot: string,
  candidate: string,
): { ok: true; resolved: string; exists: boolean } | { ok: false; error: string } {
  if (isAbsolute(candidate)) {
    return { ok: false, error: `absolute path not permitted: ${candidate}` };
  }
  const realRoot = realpathSync(repoRoot);
  const lexical = pathResolve(realRoot, candidate);
  // First lexical containment (cheap reject for ../ escapes).
  if (!isWithin(realRoot, lexical)) {
    return { ok: false, error: `path escapes repoRoot (lexical): ${candidate}` };
  }
  if (existsSync(lexical)) {
    // Resolve symlinks; the REAL target must still be inside the REAL root.
    const real = realpathSync(lexical);
    if (!isWithin(realRoot, real)) {
      return { ok: false, error: `path escapes repoRoot via symlink: ${candidate}` };
    }
    return { ok: true, resolved: real, exists: true };
  }
  // Not-yet-existing: walk up to the nearest existing ancestor and confirm IT
  // does not symlink-escape. This blocks `existing-symlink-dir/newfile`.
  let probe = lexical;
  while (probe !== realRoot && isWithin(realRoot, probe)) {
    const parent = pathResolve(probe, "..");
    if (existsSync(parent)) {
      const realParent = realpathSync(parent);
      if (!isWithin(realRoot, realParent)) {
        return { ok: false, error: `ancestor escapes repoRoot via symlink: ${candidate}` };
      }
      break;
    }
    probe = parent;
  }
  return { ok: true, resolved: lexical, exists: false };
}

// ---------------------------------------------------------------------------
// Matching — pure, treats criterion value as DATA never instruction (§6 inv 3).
// ---------------------------------------------------------------------------

export function matches(text: string, crit: MatchCriterion): boolean {
  switch (crit.kind) {
    case "substring":
      return text.includes(crit.value);
    case "regex": {
      // Defense-in-depth (codex P2-1): even after the nested-quantifier screen,
      // bound the input length handed to a worker-supplied pattern so it can
      // never be fed an unbounded-length string.
      //
      // S3 — FAIL CLOSED above the cap (do NOT slice-and-test). Slicing the text
      // to a prefix before re.test() is UNSOUND for END-ANCHORED / position-
      // dependent patterns: a `/SAFE$/` can match a truncated prefix that ends in
      // "SAFE" while the FULL text ends in something else (VERIFIED: 104k text,
      // prefix ends "SAFE", full ends "MORE" → slice-test=true while full-text
      // /SAFE$/=false). So truncation can turn a false into a TRUE (a false PASS)
      // for anchored patterns — the opposite of the old comment's claim. We
      // cannot soundly evaluate an anchored pattern on a prefix, so over the cap
      // we return false (not reproduced). That is over-rejection, the SLI's
      // intended fail-closed stance, and it also defuses any residual catastrophic
      // pattern on huge input (the engine never runs on >cap text).
      if (text.length > DEFAULT_MAX_REGEX_TEST_CHARS) {
        return false;
      }
      // crit.value already validated at parse time; recompile deterministically.
      const re = new RegExp(crit.value, crit.flags);
      return re.test(text);
    }
    case "empty":
      // Output is "empty" iff it has no non-whitespace characters.
      return text.trim().length === 0;
  }
}

// ---------------------------------------------------------------------------
// reproduce — the S3a deterministic reproducer. Records only, NO conclusion.
// ---------------------------------------------------------------------------

export function reproduce(
  raw: unknown,
  repoRoot: string,
  opts: SandboxOptions = {},
): ReproRecord {
  const parsed = parsePointer(raw);
  if (!parsed.ok) {
    // Unparseable / invalid pointer → non-reproducible BEFORE execution.
    return {
      reproduced: false,
      reachable: false,
      detail: { stage: "parse", error: parsed.error },
    };
  }
  const pointer = parsed.pointer;
  if (pointer.type === "file") {
    return reproduceFile(pointer, repoRoot, opts);
  }
  return reproduceCommand(pointer, repoRoot, opts);
}

/**
 * A failure ReproRecord: could not reach the evidence → reproduced:false,
 * reachable:false. Fail-closed default; `detail` carries the diagnostic stage.
 */
function unreachable(detail: Record<string, unknown>): ReproRecord {
  return { reproduced: false, reachable: false, detail };
}

function reproduceFile(
  pointer: FilePointer,
  repoRoot: string,
  opts: SandboxOptions,
): ReproRecord {
  const path = pointer.path;
  let resolved;
  try {
    resolved = resolveUnderRoot(repoRoot, path);
  } catch (e) {
    return unreachable({ type: "file", path, stage: "resolve", error: (e as Error).message });
  }
  if (!resolved.ok) {
    return unreachable({ type: "file", path, stage: "resolve", error: resolved.error });
  }
  if (!resolved.exists) {
    // Missing file: reachable:false (couldn't reach), reproduced:false.
    return unreachable({ type: "file", path, exists: false });
  }
  let st;
  try {
    st = statSync(resolved.resolved);
  } catch (e) {
    return unreachable({ type: "file", path, stage: "stat", error: (e as Error).message });
  }
  if (!st.isFile()) {
    return unreachable({ type: "file", path, exists: true, isFile: false });
  }
  // Cap the bytes read (codex P2-2): mirror the command-path output cap so a
  // huge file can't be slurped whole into memory. On overflow we read only the
  // first N bytes and mark the record truncated so a partial match can NEVER
  // masquerade as a full-content match.
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const truncated = st.size > maxFileBytes;
  let content: string;
  try {
    content = truncated
      ? readFilePrefixUtf8(resolved.resolved, maxFileBytes)
      : readFileSync(resolved.resolved, "utf8");
  } catch (e) {
    return unreachable({ type: "file", path, stage: "read", error: (e as Error).message });
  }
  // File exists & readable → reachable:true. mustMatch decides reproduced.
  // When truncated, a NEGATIVE match is honest (the pattern was not in the
  // prefix → not reproduced); a POSITIVE match on a truncated prefix is still a
  // real match (the bytes are genuinely present), but the detail flags
  // truncation so downstream can never treat a partial read as full-content.
  const matched = matches(content, pointer.mustMatch);
  const detail: Record<string, unknown> = {
    type: "file",
    path,
    exists: true,
    criterionKind: pointer.mustMatch.kind,
    matched,
  };
  if (truncated) {
    detail.truncated = true;
    detail.size = st.size;
    detail.readBytes = maxFileBytes;
  }
  return { reproduced: matched, reachable: true, detail };
}

/**
 * Read at most `maxBytes` bytes from the head of a file and decode as UTF-8.
 * Used when statSync reports a file larger than the cap so we never allocate
 * the whole file (codex P2-2).
 */
function readFilePrefixUtf8(file: string, maxBytes: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function reproduceCommand(
  pointer: CommandPointer,
  repoRoot: string,
  opts: SandboxOptions,
): ReproRecord {
  const cmd = pointer.cmd;
  const cmdCheck = validateCommand(cmd);
  if (!cmdCheck.ok) {
    // Should not happen (validated at parse), but fail-closed regardless.
    return unreachable({ type: "command", cmd, stage: "validate", error: cmdCheck.error });
  }
  const argv = cmdCheck.argv;
  const head = argv[0]!;
  const args = argv.slice(1);

  // Confirm every relative path arg resolves under repoRoot (reject symlink
  // escape). We do a best-effort containment check on arg tokens that look like
  // paths (contain a path separator or refer to an existing file).
  let realRoot: string;
  try {
    realRoot = realpathSync(repoRoot);
  } catch (e) {
    return unreachable({ type: "command", cmd, stage: "resolve-root", error: (e as Error).message });
  }
  // S2 — flag VALUES that look like paths must be CONTAINED, not blanket-skipped.
  // The old loop skipped every `-`-prefixed token except a HARD-CODED list of
  // path-bearing flags, so a non-enumerated path flag (`git diff --output=../x`,
  // `git log --output=../x`, `git diff -o../x`) WROTE a file OUTSIDE repoRoot via
  // an allowlisted read-only subcommand and still returned reproduced:true. The
  // enumerated PATH_BEARING_FLAGS list is open-ended and can NEVER be exhaustive,
  // so the REAL gate is VALUE-BASED: for ANY flag token, if it carries a
  // path-looking value (attached `--flag=VALUE` / `-xVALUE`, or a separate next
  // token), route that value through resolveUnderRoot and reject on escape.
  // Genuinely path-free values (`--oneline`, `-n5`, `--format=oneline`,
  // `recurse`) contain no separator → still pass. PATH_BEARING_FLAGS remains a
  // fast-path hint that FORCES containment of a separate next token even when it
  // doesn't itself look path-like (e.g. `-C status`, where `status` is a real
  // contained dir we still want resolved).
  const pathFlags = PATH_BEARING_FLAGS[head];
  const checkContained = (value: string): ReproRecord | null => {
    const r = resolveUnderRoot(realRoot, value);
    if (!r.ok) {
      return unreachable({ type: "command", cmd, stage: "resolve-arg", arg: value, error: r.error });
    }
    return null;
  };
  for (let a = 0; a < args.length; a++) {
    const arg = args[a]!;
    if (arg.startsWith("-")) {
      if (arg.startsWith("--")) {
        // Long form. Attached `--flag=VALUE`: contain VALUE if it looks like a
        // path (covers the non-enumerated `--output=../x` escape).
        const eq = arg.indexOf("=");
        if (eq !== -1) {
          const value = arg.slice(eq + 1);
          if (looksLikePath(realRoot, value)) {
            const rej = checkContained(value);
            if (rej) return rej;
          }
          continue;
        }
        // Separate `--flag VALUE`: contain the next token when it looks like a
        // path, OR when this is an enumerated path-bearing long flag (hint).
        const name = arg;
        const nameIsHinted = pathFlags?.long.has(name) ?? false;
        const next = args[a + 1];
        if (next !== undefined && (nameIsHinted || looksLikePath(realRoot, next))) {
          const rej = checkContained(next);
          if (rej) return rej;
          a++; // consume the separate value token
        }
        continue;
      }
      // Short form. Attached `-xVALUE` (`-o../x`, `-Cstatus`): contain the
      // trailing value when it looks like a path.
      if (arg.length > 2) {
        const value = arg.slice(2);
        if (looksLikePath(realRoot, value)) {
          const rej = checkContained(value);
          if (rej) return rej;
        }
        continue;
      }
      // Bare short `-x`: contain the next token when it looks like a path, OR
      // when this is an enumerated path-bearing short flag (hint).
      const shortIsHinted = pathFlags?.short.has(arg) ?? false;
      const next = args[a + 1];
      if (next !== undefined && (shortIsHinted || looksLikePath(realRoot, next))) {
        const rej = checkContained(next);
        if (rej) return rej;
        a++; // consume the separate value token
      }
      continue;
    }
    // A positional token: enforce containment when it resolves to something
    // existing or contains a separator; pure pattern args (e.g. a grep regex)
    // are passed through as literal argv (no shell, so they cannot escape).
    if (looksLikePath(realRoot, arg)) {
      const rej = checkContained(arg);
      if (rej) return rej;
    }
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  let res;
  try {
    res = spawnSync(head, args, {
      cwd: realRoot,
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      shell: false, // never a shell
      windowsHide: true,
      encoding: "utf8",
      // Fixed minimal env, no network-affecting vars. PATH kept minimal so the
      // allowlisted heads resolve; no proxy / no inherited secrets.
      env: {
        PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
        LANG: "C",
        LC_ALL: "C",
        HOME: realRoot,
        // Defense-in-depth (codex P3-b): never let an allowlisted `git` read a
        // system/global config, prompt for credentials, or hit a terminal.
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  } catch (e) {
    return unreachable({ type: "command", cmd, stage: "spawn", error: (e as Error).message });
  }

  const signal = (res as { signal?: string | null }).signal ?? null;

  // Spawn-level error (ENOENT for a missing binary, timeout, buffer overflow).
  if (res.error) {
    const err = res.error as NodeJS.ErrnoException;
    const timedOut = signal === "SIGTERM" || err.code === "ETIMEDOUT";
    return unreachable({
      type: "command",
      cmd,
      stage: "run",
      ran: false,
      error: err.message,
      code: err.code,
      timedOut,
    });
  }

  // It ran → reachable:true. Grade exit + output match.
  const stdout = typeof res.stdout === "string" ? res.stdout : "";
  const stderr = typeof res.stderr === "string" ? res.stderr : "";
  const exit = res.status; // null if killed by signal
  if (exit === null) {
    // Killed by a signal (e.g. timeout SIGTERM) → did not complete → not reached.
    return unreachable({ type: "command", cmd, stage: "run", ran: false, signal });
  }
  const exitOk = exit === pointer.expectExit;
  const outputMatched = matches(stdout, pointer.mustMatch);
  const reproduced = exitOk && outputMatched;
  return {
    reproduced,
    reachable: true,
    detail: {
      type: "command",
      cmd,
      ran: true,
      exit,
      expectExit: pointer.expectExit,
      exitOk,
      criterionKind: pointer.mustMatch.kind,
      outputMatched,
      stderr: stderr.slice(0, 2000),
    },
  };
}
