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
 * reject the dangerous shape at its entry point. The two classic
 * catastrophic-backtracking roots are:
 *   1. an unbounded quantifier (`*`, `+`, `{n,}`) applied to a group whose body
 *      ITSELF contains an unbounded quantifier — e.g. `(a+)+`, `(a*)*`, `([a-z]+)*`;
 *   2. an unbounded quantifier applied to a group whose body contains a
 *      top-level ALTERNATION — e.g. `(a|a)+`, `(a|ab)*` (overlapping/ambiguous
 *      alternatives multiply the backtracking paths).
 * Rejecting both shapes (plus the input-length cap in `matches`) bounds the
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
  // its BODY contains an unbounded quantifier OR a top-level alternation; if such
  // a group is then itself quantified unbounded, that is the catastrophic shape.
  type Frame = { bodyHasUnbounded: boolean; bodyHasAlternation: boolean };
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
      stack.push({ bodyHasUnbounded: false, bodyHasAlternation: false });
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
      if (frame && (frame.bodyHasUnbounded || frame.bodyHasAlternation) && groupQuantUnbounded) {
        return true; // (…unbounded…|alternation…)<unbounded> → catastrophic
      }
      continue;
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
      // crit.value already validated at parse time; recompile deterministically.
      const re = new RegExp(crit.value, crit.flags);
      // Defense-in-depth (codex P2-1): even after the nested-quantifier screen,
      // cap the input length so a worker-supplied pattern can never be fed an
      // unbounded-length string. Truncation only shrinks the haystack — it can
      // turn a true match into a false one (fail-closed: never a false PASS),
      // never the reverse.
      const haystack =
        text.length > DEFAULT_MAX_REGEX_TEST_CHARS
          ? text.slice(0, DEFAULT_MAX_REGEX_TEST_CHARS)
          : text;
      return re.test(haystack);
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
  for (const arg of args) {
    if (arg.startsWith("-")) continue; // flags
    // Only enforce containment when the token resolves to something existing or
    // contains a separator; pure pattern args (e.g. a grep regex) are passed
    // through as literal argv (no shell, so they cannot escape).
    if (arg.includes("/") || existsSync(pathResolve(realRoot, arg))) {
      const r = resolveUnderRoot(realRoot, arg);
      if (!r.ok) {
        return unreachable({ type: "command", cmd, stage: "resolve-arg", arg, error: r.error });
      }
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
