// tests/pointer.test.ts — Phase 2 (EvidencePointer + sandbox + S3a reproducer)

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePointer,
  validateCommand,
  resolveUnderRoot,
  matches,
  reproduce,
} from "../src/pointer.ts";

// A throwaway repo root with a few fixture files.
let repoRoot: string;
let outsideRoot: string;

beforeAll(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "sli-ptr-")));
  outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), "sli-out-")));
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "cli.js"), "#!/usr/bin/env node\nconsole.log('hi');\n");
  writeFileSync(join(repoRoot, "config.yaml"), "enabled: false\nname: demo\n");
  // A secret OUTSIDE the root, plus a symlink inside the root pointing to it.
  writeFileSync(join(outsideRoot, "secret.txt"), "TOP SECRET\n");
  symlinkSync(join(outsideRoot, "secret.txt"), join(repoRoot, "escape-link"));
  symlinkSync(outsideRoot, join(repoRoot, "escape-dir"));
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

describe("parsePointer — typed criterion is required (codex P1-3)", () => {
  test("command with NO mustMatch criterion → REJECTED", () => {
    const r = parsePointer({ type: "command", cmd: "true", expectExit: 0 });
    expect(r.ok).toBe(false);
  });

  test("command with EMPTY substring criterion → REJECTED (matches everything)", () => {
    const r = parsePointer({ type: "command", cmd: "true", expectExit: 0, mustMatch: { kind: "substring", value: "" } });
    expect(r.ok).toBe(false);
  });

  test("command with bare-string criterion (not a typed object) → REJECTED", () => {
    const r = parsePointer({ type: "command", cmd: "ls", expectExit: 0, mustMatch: "something" as unknown });
    expect(r.ok).toBe(false);
  });

  test("command with explicit kind:empty criterion (allowlisted head) → accepted", () => {
    const r = parsePointer({ type: "command", cmd: "test -f x", expectExit: 0, mustMatch: { kind: "empty" } });
    expect(r.ok).toBe(true);
  });

  test('cmd:"true" (non-allowlisted head) is rejected even with a valid criterion', () => {
    const r = parsePointer({ type: "command", cmd: "true", expectExit: 0, mustMatch: { kind: "empty" } });
    expect(r.ok).toBe(false);
  });

  test("file with regex criterion → accepted", () => {
    const r = parsePointer({ type: "file", path: "src/cli.js", mustMatch: { kind: "regex", value: "^#!/usr/bin/env node" } });
    expect(r.ok).toBe(true);
  });

  test("file with substring criterion → accepted", () => {
    const r = parsePointer({ type: "file", path: "src/cli.js", mustMatch: { kind: "substring", value: "node" } });
    expect(r.ok).toBe(true);
  });

  test("file with bad regex → REJECTED (unparseable)", () => {
    const r = parsePointer({ type: "file", path: "x", mustMatch: { kind: "regex", value: "(" } });
    expect(r.ok).toBe(false);
  });
});

describe("validateCommand — closed read-only allowlist + metachar rejection (codex P2-3)", () => {
  test("allowlisted head with literal args → ok", () => {
    expect(validateCommand("git log").ok).toBe(true);
    expect(validateCommand("grep -n foo src/cli.js").ok).toBe(true);
    expect(validateCommand("cat config.yaml").ok).toBe(true);
  });

  test("non-allowlisted head → rejected", () => {
    expect(validateCommand("curl http://evil").ok).toBe(false);
    expect(validateCommand("rm -rf .").ok).toBe(false);
    expect(validateCommand("python script.py").ok).toBe(false);
  });

  test.each([
    "cat foo > out.txt",
    "cat foo >> out.txt",
    "cat foo | grep bar",
    "ls; rm x",
    "ls && rm x",
    "echo $(whoami)",
    "echo `whoami`",
    "git log\nrm x",
  ])("metachar/redirect/chain rejected: %p", (cmd: string) => {
    expect(validateCommand(cmd).ok).toBe(false);
  });

  test("absolute path in args → rejected", () => {
    expect(validateCommand("cat /etc/passwd").ok).toBe(false);
    expect(validateCommand("grep foo /usr/bin/env").ok).toBe(false);
  });
});

describe("resolveUnderRoot — symlink escape rejection", () => {
  test("contained relative path → ok", () => {
    const r = resolveUnderRoot(repoRoot, "src/cli.js");
    expect(r.ok).toBe(true);
  });

  test("../ escape → rejected", () => {
    const r = resolveUnderRoot(repoRoot, "../escape");
    expect(r.ok).toBe(false);
  });

  test("symlink file escaping the root → rejected", () => {
    const r = resolveUnderRoot(repoRoot, "escape-link");
    expect(r.ok).toBe(false);
  });

  test("symlink dir escaping the root → rejected", () => {
    const r = resolveUnderRoot(repoRoot, "escape-dir");
    expect(r.ok).toBe(false);
  });
});

describe("matches — pure, treats criterion as DATA", () => {
  test("substring", () => {
    expect(matches("hello world", { kind: "substring", value: "world" })).toBe(true);
    expect(matches("hello world", { kind: "substring", value: "nope" })).toBe(false);
  });
  test("regex with flags", () => {
    expect(matches("HELLO", { kind: "regex", value: "hello", flags: "i" })).toBe(true);
    expect(matches("HELLO", { kind: "regex", value: "hello" })).toBe(false);
  });
  test("empty kind", () => {
    expect(matches("   \n ", { kind: "empty" })).toBe(true);
    expect(matches("x", { kind: "empty" })).toBe(false);
  });
});

describe("reproduce — S3a deterministic reproducer (file)", () => {
  test("file mustMatch present (regex) → reproduced:true, reachable:true", () => {
    const rec = reproduce(
      { type: "file", path: "src/cli.js", mustMatch: { kind: "regex", value: "^#!/usr/bin/env node" } },
      repoRoot,
    );
    expect(rec.reachable).toBe(true);
    expect(rec.reproduced).toBe(true);
  });

  test("file mustMatch present (substring) → reproduced:true", () => {
    const rec = reproduce(
      { type: "file", path: "config.yaml", mustMatch: { kind: "substring", value: "enabled: false" } },
      repoRoot,
    );
    expect(rec.reachable).toBe(true);
    expect(rec.reproduced).toBe(true);
  });

  test("file mustMatch absent → reproduced:false, reachable:true", () => {
    const rec = reproduce(
      { type: "file", path: "config.yaml", mustMatch: { kind: "substring", value: "NOT-THERE" } },
      repoRoot,
    );
    expect(rec.reachable).toBe(true);
    expect(rec.reproduced).toBe(false);
  });

  test("missing file → reachable:false, reproduced:false", () => {
    const rec = reproduce(
      { type: "file", path: "src/nope.js", mustMatch: { kind: "substring", value: "x" } },
      repoRoot,
    );
    expect(rec.reachable).toBe(false);
    expect(rec.reproduced).toBe(false);
  });

  test("unparseable pointer → reachable:false (non-reproducible before exec)", () => {
    const rec = reproduce({ type: "command", cmd: "true", expectExit: 0 }, repoRoot);
    expect(rec.reachable).toBe(false);
    expect(rec.reproduced).toBe(false);
    expect((rec.detail as { stage?: string }).stage).toBe("parse");
  });

  test("determinism: same input → same record", () => {
    const ptr = { type: "file", path: "config.yaml", mustMatch: { kind: "substring", value: "enabled: false" } };
    const a = reproduce(ptr, repoRoot);
    const b = reproduce(ptr, repoRoot);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("reproduce — S3a deterministic reproducer (command, sandboxed)", () => {
  test("a side-effecting/networked cmd is rejected → non-reproducible pre-exec", () => {
    const rec = reproduce(
      { type: "command", cmd: "curl http://example.com", expectExit: 0, mustMatch: { kind: "empty" } },
      repoRoot,
    );
    expect(rec.reachable).toBe(false);
    expect(rec.reproduced).toBe(false);
  });

  test("grep finds a substring → reproduced:true (exit 0 + output match)", () => {
    const rec = reproduce(
      { type: "command", cmd: "grep enabled config.yaml", expectExit: 0, mustMatch: { kind: "substring", value: "enabled: false" } },
      repoRoot,
    );
    expect(rec.reachable).toBe(true);
    expect(rec.reproduced).toBe(true);
  });

  test('the "empty" command criterion graded correctly', () => {
    // `git diff` on a fresh non-repo errors (non-zero); use a deterministic
    // allowlisted command that produces no stdout: `test -f config.yaml` exits 0
    // with empty output.
    const rec = reproduce(
      { type: "command", cmd: "test -f config.yaml", expectExit: 0, mustMatch: { kind: "empty" } },
      repoRoot,
    );
    expect(rec.reachable).toBe(true);
    expect(rec.reproduced).toBe(true);
  });

  test('the "empty" criterion FAILS when output is non-empty', () => {
    const rec = reproduce(
      { type: "command", cmd: "cat config.yaml", expectExit: 0, mustMatch: { kind: "empty" } },
      repoRoot,
    );
    expect(rec.reachable).toBe(true);
    expect(rec.reproduced).toBe(false);
  });

  test("wrong exit code → reproduced:false even if output matches", () => {
    // grep for a missing pattern exits 1; expectExit:0 → reproduced:false.
    const rec = reproduce(
      { type: "command", cmd: "grep MISSING-PATTERN config.yaml", expectExit: 0, mustMatch: { kind: "empty" } },
      repoRoot,
    );
    expect(rec.reachable).toBe(true);
    expect(rec.reproduced).toBe(false);
  });
});

// ===========================================================================
// P2-1 — ReDoS: a DISTRUSTED worker pattern can NOT block the event loop.
// The catastrophic patterns are REJECTED at parse time (nested unbounded
// quantifier), and reproduce() returns reproduced:false WITHIN a small bound.
// ===========================================================================

describe("P2-1 — catastrophic-backtracking regex is bounded (no event-loop hang)", () => {
  // The classic ReDoS trio: each pins a backtracking engine for ~minutes on a
  // crafted non-matching input. They MUST be rejected (or otherwise bounded).
  const CATASTROPHIC = ["(a+)+$", "(a*)*$", "(a+)+b", "(\\d+)+$", "(a|a)+$", "([a-z]+)*$"];
  // A 40-char input that forces maximal backtracking on the above.
  const evilInput = "a".repeat(40) + "!";

  test.each(CATASTROPHIC)("parsePointer REJECTS nested-unbounded pattern %p", (value: string) => {
    const r = parsePointer({ type: "file", path: "x", mustMatch: { kind: "regex", value } });
    expect(r.ok).toBe(false);
  });

  test("(a+)+$ against a crafted input is BOUNDED (< 1s) and reproduced:false", () => {
    // Write a fixture file whose content is the evil input, then point a regex
    // criterion at it. The pattern is rejected at parse → reproduced:false,
    // reachable:false (stage:parse). Crucially: NO hang.
    writeFileSync(join(repoRoot, "evil.txt"), evilInput);
    const t0 = performance.now();
    const rec = reproduce(
      { type: "file", path: "evil.txt", mustMatch: { kind: "regex", value: "(a+)+$" } },
      repoRoot,
    );
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(1000); // measured bound — no event-loop block
    expect(rec.reproduced).toBe(false);
    expect(rec.reachable).toBe(false);
    expect((rec.detail as { stage?: string }).stage).toBe("parse");
  });

  test("a SAFE bounded-quantifier regex still works (no over-broad rejection)", () => {
    // `a{1,5}` and `(ab)+` are NOT nested-unbounded → accepted + functional.
    expect(matches("aaa", { kind: "regex", value: "a{1,5}" })).toBe(true);
    expect(matches("abab", { kind: "regex", value: "(ab)+" })).toBe(true);
    const r1 = parsePointer({ type: "file", path: "x", mustMatch: { kind: "regex", value: "a{1,5}" } });
    expect(r1.ok).toBe(true);
    const r2 = parsePointer({ type: "file", path: "x", mustMatch: { kind: "regex", value: "(ab)+c" } });
    expect(r2.ok).toBe(true);
  });

  test("matches() caps input length so a worker pattern can't be fed unbounded text", () => {
    // A simple linear pattern against a 5 MB string returns fast and correctly
    // (the cap only shrinks the haystack; a match in the prefix still matches).
    const big = "x".repeat(5_000_000) + "NEEDLE";
    const t0 = performance.now();
    // NEEDLE is past the 100k cap → truncated away → no match (fail-closed).
    const found = matches(big, { kind: "regex", value: "NEEDLE" });
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(1000);
    expect(found).toBe(false);
    // A match WITHIN the prefix is still found.
    expect(matches("x".repeat(10) + "NEEDLE", { kind: "regex", value: "NEEDLE" })).toBe(true);
  });
});

// ===========================================================================
// P2-2 — file byte cap: a file larger than the cap is read TRUNCATED, and the
// reproduction detail flags truncation so a partial match can't masquerade as
// a full-content match. A pattern only present PAST the cap → not reproduced.
// ===========================================================================

describe("P2-2 — reproduceFile caps bytes read (no whole-file slurp)", () => {
  test("a needle BEYOND the cap is NOT reproduced + detail flags truncation", () => {
    // Build a file whose first 200 bytes are filler and whose needle sits past a
    // tiny cap; with maxFileBytes:64 the read stops before the needle.
    const big = "A".repeat(200) + "NEEDLE_PAST_CAP\n";
    writeFileSync(join(repoRoot, "big.txt"), big);
    const rec = reproduce(
      { type: "file", path: "big.txt", mustMatch: { kind: "substring", value: "NEEDLE_PAST_CAP" } },
      repoRoot,
      { maxFileBytes: 64 },
    );
    expect(rec.reachable).toBe(true);
    expect(rec.reproduced).toBe(false); // past the cap → not in the prefix
    expect((rec.detail as { truncated?: boolean }).truncated).toBe(true);
    expect((rec.detail as { readBytes?: number }).readBytes).toBe(64);
  });

  test("a needle WITHIN the cap is reproduced even when the file is truncated", () => {
    const big = "HEADER_NEEDLE" + "B".repeat(5000);
    writeFileSync(join(repoRoot, "big2.txt"), big);
    const rec = reproduce(
      { type: "file", path: "big2.txt", mustMatch: { kind: "substring", value: "HEADER_NEEDLE" } },
      repoRoot,
      { maxFileBytes: 64 },
    );
    expect(rec.reachable).toBe(true);
    expect(rec.reproduced).toBe(true); // present in the prefix → genuine match
    expect((rec.detail as { truncated?: boolean }).truncated).toBe(true);
  });

  test("a small file (under the cap) is NOT flagged truncated", () => {
    const rec = reproduce(
      { type: "file", path: "config.yaml", mustMatch: { kind: "substring", value: "enabled: false" } },
      repoRoot,
    );
    expect(rec.reproduced).toBe(true);
    expect((rec.detail as { truncated?: boolean }).truncated).toBeUndefined();
  });
});
