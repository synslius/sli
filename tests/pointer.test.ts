// tests/pointer.test.ts — Phase 2 (EvidencePointer + sandbox + S3a reproducer)

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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

// ===========================================================================
// Wave 7 hardening — PERMANENT regression guards (one per finding). Each asserts
// the original VERIFIED exploit now FAILS CLOSED (rejected / reproduced:false),
// never a mutation or an out-of-root read.
// ===========================================================================

// S1 — git MUTATING subcommands run under repoRoot through the head-only check.
// VERIFIED: `git clean -fd` deleted an untracked file; `git reset --hard`
// destroyed uncommitted work; `git init` created .git. Now REJECTED at parse
// (validateCommand ok:false) so the mutation never spawns.
describe("S1 — git read-only subcommand allowlist (no mutating git)", () => {
  test.each([
    "git clean -fd",
    "git reset --hard",
    "git init",
    "git checkout .",
    "git rm file",
    "git stash",
    "git commit -m x",
    "git add .",
    "git fetch",
    "git pull",
    "git push",
    "git merge main",
    "git branch x",
    "git gc",
    "git tag v1",
  ])("MUTATING %p is REJECTED at parse (no spawn, no mutation)", (cmd: string) => {
    expect(validateCommand(cmd).ok).toBe(false);
    // Also rejected through the full pointer parse (never reaches the sandbox).
    const p = parsePointer({ type: "command", cmd, expectExit: 0, mustMatch: { kind: "empty" } });
    expect(p.ok).toBe(false);
  });

  test("bare `git` with NO subcommand is REJECTED", () => {
    expect(validateCommand("git").ok).toBe(false);
  });

  test("READ-ONLY git subcommands remain accepted", () => {
    for (const sub of ["log", "show", "status", "diff", "cat-file", "rev-parse", "ls-files", "blame", "grep"]) {
      expect(validateCommand(`git ${sub}`).ok).toBe(true);
    }
  });

  test("REPRO: `git clean -fd` does NOT delete an untracked file (fail-closed)", () => {
    // Lay an untracked file under the root, run the exploit through reproduce(),
    // assert it is non-reproducible AND the file is still present.
    const victim = join(repoRoot, "untracked-victim.txt");
    writeFileSync(victim, "do not delete me\n");
    const rec = reproduce(
      { type: "command", cmd: "git clean -fd", expectExit: 0, mustMatch: { kind: "empty" } },
      repoRoot,
    );
    expect(rec.reproduced).toBe(false);
    expect(rec.reachable).toBe(false);
    expect((rec.detail as { stage?: string }).stage).toBe("parse"); // rejected before exec
    expect(existsSync(victim)).toBe(true); // NO mutation
  });
});

// S2 — path-bearing flags bypassed resolveUnderRoot via the blanket `-` skip.
// VERIFIED: `git --git-dir=../external/.git show HEAD:secret.txt` read OUTSIDE
// repoRoot. Now the flag value is routed through resolveUnderRoot and rejected
// on escape (the `show` subcommand passes S1; S2's containment catches the dir).
describe("S2 — path-bearing flags are contained, not blanket-skipped", () => {
  test("REPRO: `git --git-dir=<external>` escape → reproduced:false (resolve-arg reject)", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "sli-s2-")));
    const inner = join(base, "repo");
    const external = join(base, "external");
    mkdirSync(inner);
    mkdirSync(external);
    // A real committed git repo OUTSIDE the sandbox root, holding a secret.
    const g = (args: string[], cwd: string) => spawnSync("git", args, { cwd, encoding: "utf8" });
    g(["init", "-q"], external);
    g(["config", "user.email", "x@x"], external);
    g(["config", "user.name", "x"], external);
    writeFileSync(join(external, "secret.txt"), "TOP SECRET\n");
    g(["add", "."], external);
    g(["commit", "-q", "-m", "x"], external);

    // S1 lets `show` through (read-only); S2 must reject the --git-dir escape.
    expect(validateCommand("git --git-dir=../external/.git show HEAD:secret.txt").ok).toBe(true);
    const rec = reproduce(
      {
        type: "command",
        cmd: "git --git-dir=../external/.git show HEAD:secret.txt",
        expectExit: 0,
        mustMatch: { kind: "substring", value: "TOP SECRET" },
      },
      inner,
    );
    expect(rec.reproduced).toBe(false);
    expect(rec.reachable).toBe(false);
    expect((rec.detail as { stage?: string }).stage).toBe("resolve-arg");

    rmSync(base, { recursive: true, force: true });
  });

  test("a contained `-f` pattern-file flag with an escaping value → rejected", () => {
    // grep -f reads its pattern from a file; an escaping path must be rejected.
    const rec = reproduce(
      { type: "command", cmd: "grep -f ../escape/patterns config.yaml", expectExit: 0, mustMatch: { kind: "empty" } },
      repoRoot,
    );
    expect(rec.reproduced).toBe(false);
    expect(rec.reachable).toBe(false);
    expect((rec.detail as { stage?: string }).stage).toBe("resolve-arg");
  });

  test("a genuinely path-free flag (-n) still passes through (no over-reject)", () => {
    const rec = reproduce(
      { type: "command", cmd: "grep -n enabled config.yaml", expectExit: 0, mustMatch: { kind: "substring", value: "enabled: false" } },
      repoRoot,
    );
    expect(rec.reachable).toBe(true);
    expect(rec.reproduced).toBe(true);
  });
});

// S3 — slicing text to a prefix before re.test() is UNSOUND for END-ANCHORED
// patterns. VERIFIED: 104k text, prefix ends "SAFE", full ends "MORE" →
// slice-test=true while full-text /SAFE$/=false (a FALSE PASS). Now matches()
// FAILS CLOSED (returns false) for any text above the cap.
describe("S3 — anchored regex over the cap fails closed (no false PASS)", () => {
  test("REPRO: /SAFE$/ on a 104k text whose prefix ends SAFE but full ends MORE → false", () => {
    const CAP = 100_000;
    // First 100k chars end in "SAFE" (the slice boundary); the genuine full text
    // ends in "MORE", so full-text /SAFE$/ is FALSE.
    const text = "x".repeat(CAP - 4) + "SAFE" + "x".repeat(100) + "MORE";
    expect(text.length).toBeGreaterThan(CAP);
    expect(/SAFE$/.test(text)).toBe(false); // the genuine answer
    // matches() must NOT report a spurious true from the truncated prefix.
    expect(matches(text, { kind: "regex", value: "SAFE$" })).toBe(false);
  });

  test("a within-cap anchored match is still honest (no over-reject under the cap)", () => {
    expect(matches("hello SAFE", { kind: "regex", value: "SAFE$" })).toBe(true);
    expect(matches("SAFE then more", { kind: "regex", value: "SAFE$" })).toBe(false);
  });
});

// S4 — recursive/symlink-following grep can read OUTSIDE repoRoot.
// VERIFIED: `grep -RS .` read an external symlink target. Now the symlink-
// following / recursive-deref grep flags are rejected at parse.
describe("S4 — grep symlink-following / recursive flags rejected", () => {
  test.each([
    "grep -RS .",
    "grep -R .",
    "grep -r pattern .",
    "grep -rn pattern .",
    "grep --dereference-recursive pattern .",
    "grep --dereference pattern file",
    "grep -O pattern file",
    "grep --dereference-argument pattern file",
  ])("recursive/deref grep %p is REJECTED at parse", (cmd: string) => {
    expect(validateCommand(cmd).ok).toBe(false);
  });

  test("non-recursive grep flags (-n, -i, -c) remain accepted", () => {
    expect(validateCommand("grep -n pattern config.yaml").ok).toBe(true);
    expect(validateCommand("grep -i pattern config.yaml").ok).toBe(true);
    expect(validateCommand("grep -c pattern config.yaml").ok).toBe(true);
  });

  test("REPRO: `grep -RS .` against the symlink-escaping root → reproduced:false", () => {
    // escape-dir is a symlink out of the root (set up in beforeAll). A recursive
    // grep would follow it; the flag is now rejected pre-exec.
    const rec = reproduce(
      { type: "command", cmd: "grep -RS TOP escape-dir", expectExit: 0, mustMatch: { kind: "substring", value: "TOP SECRET" } },
      repoRoot,
    );
    expect(rec.reproduced).toBe(false);
    expect(rec.reachable).toBe(false);
  });
});

// S6 — the screen only marked *,+,{n,} as inner-unbounded, so optional-`?`
// shapes slipped through and burned seconds. VERIFIED: (a?)+b=880ms,
// (a*)?b=4318ms at 100k. Now these are rejected at parse.
describe("S6 — optional-`?` group shapes rejected (catastrophic-backtracking)", () => {
  test.each(["(a?)+b", "(a*)?b", "(a?)*b", "([a-z]?)+9"])(
    "parsePointer REJECTS optional-`?` shape %p",
    (value: string) => {
      const r = parsePointer({ type: "file", path: "x", mustMatch: { kind: "regex", value } });
      expect(r.ok).toBe(false);
    },
  );

  test("(a?)+b and (a*)?b are bounded (< 1s) via parse rejection — no event-loop burn", () => {
    for (const value of ["(a?)+b", "(a*)?b"]) {
      const t0 = performance.now();
      const r = parsePointer({ type: "file", path: "x", mustMatch: { kind: "regex", value } });
      const elapsedMs = performance.now() - t0;
      expect(r.ok).toBe(false);
      expect(elapsedMs).toBeLessThan(1000);
    }
  });

  test("SAFE optional shapes are NOT over-rejected", () => {
    // A `?` body with no outer ambiguity, or a `?` group with a safe body, still parse.
    for (const value of ["(a?)b", "(ab)?c", "foo(bar)?", "(ab)+c", "a{1,5}"]) {
      const r = parsePointer({ type: "file", path: "x", mustMatch: { kind: "regex", value } });
      expect(r.ok).toBe(true);
    }
  });
});

// ===========================================================================
// Wave 7.1 — cross-model (codex GPT-5.5) ADJACENT-VECTOR regression guards. The
// Wave 7 fixes closed the named exploit but left an ADJACENT vector of the SAME
// class open (independently reproduced on disk against the patched code). Each
// guard asserts the codex bypass now FAILS CLOSED *and* the safe control still
// works — so the next adjacent vector of the class is closed, not just the
// single instance.
// ===========================================================================

// S1 (Wave 7.1) — the W7 subcommand scanner `find(a => !a.startsWith("-"))` is
// VALUE-BLIND: a separate-form value-taking global flag (`-C status`, `-c x=y`,
// `--git-dir status`) puts a read-only NAME (the flag's VALUE) where the scanner
// looks, so the REAL mutating subcommand runs unchecked. VERIFIED on disk:
// `git -C status clean -fd` deleted a victim under repoRoot/status;
// `git -C status reset --hard` destroyed uncommitted work. The scanner now
// consumes value-taking global flags' values so a value is never the subcommand.
describe("S1 (Wave 7.1) — value-blind git subcommand scan (separate-form global flag values)", () => {
  test.each([
    "git -C status clean",
    "git -c x=y clean",
    "git -Cstatus clean",
    "git --git-dir status clean",
    "git -C status reset --hard",
    "git --git-dir foo checkout .",
    "git -c a.b=c rm file",
  ])("VALUE-BLIND mutation %p is REJECTED (value not read as subcommand)", (cmd: string) => {
    expect(validateCommand(cmd).ok).toBe(false);
    expect(
      parsePointer({ type: "command", cmd, expectExit: 0, mustMatch: { kind: "empty" } }).ok,
    ).toBe(false);
  });

  test("MUST still ACCEPT the safe controls (value happens to equal a read-only name)", () => {
    for (const cmd of [
      "git -C status status",
      "git status",
      "git log --oneline",
      "git --git-dir=contained log",
      "git -c x=y log",
    ]) {
      expect(validateCommand(cmd).ok).toBe(true);
    }
  });

  test("REPRO: `git -C status clean -fd` does NOT delete a victim under repoRoot/status", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sli-s1v-")));
    spawnSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "status"));
    const victim = join(root, "status", "victim.txt");
    writeFileSync(victim, "do not delete me\n"); // untracked → `clean -fd` would delete
    const rec = reproduce(
      { type: "command", cmd: "git -C status clean -fd", expectExit: 0, mustMatch: { kind: "empty" } },
      root,
    );
    expect(rec.reproduced).toBe(false);
    expect(rec.reachable).toBe(false);
    expect((rec.detail as { stage?: string }).stage).toBe("parse"); // rejected before exec
    expect(existsSync(victim)).toBe(true); // NO mutation — file survives
    rmSync(root, { recursive: true, force: true });
  });
});

// S2 (Wave 7.1) — the W7 containment loop enumerated a FIXED path-bearing flag
// list, so a non-enumerated path flag (`--output=`) slipped the `arg.startsWith
// ("--")` branch and WROTE a file OUTSIDE repoRoot via an allowlisted read-only
// subcommand (VERIFIED on disk: `git diff --output=../x` / `git log --output=../x`
// wrote outside). Containment is now VALUE-BASED: ANY flag value that looks like
// a path is routed through resolveUnderRoot.
describe("S2 (Wave 7.1) — value-based path containment (non-enumerated --output= flag)", () => {
  test.each([
    "git diff --output=../escape.patch",
    "git log --output=../escape.txt",
    "git diff -o../escape.patch",
    "git diff --output-directory=../elsewhere",
  ])("path-looking flag value %p escaping the root → reproduced:false (resolve-arg reject)", (cmd: string) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "sli-s2v-")));
    const inner = join(base, "repo");
    mkdirSync(inner);
    spawnSync("git", ["init", "-q"], { cwd: inner });
    spawnSync("git", ["config", "user.email", "x@x"], { cwd: inner });
    spawnSync("git", ["config", "user.name", "x"], { cwd: inner });
    writeFileSync(join(inner, "a.txt"), "one\n");
    spawnSync("git", ["add", "."], { cwd: inner });
    spawnSync("git", ["commit", "-q", "-m", "x"], { cwd: inner });
    writeFileSync(join(inner, "a.txt"), "two\n"); // create an unstaged diff

    const outside = join(base, "escape.patch");
    const outsideTxt = join(base, "escape.txt");
    const rec = reproduce(
      { type: "command", cmd, expectExit: 0, mustMatch: { kind: "empty" } },
      inner,
    );
    expect(rec.reproduced).toBe(false);
    expect(rec.reachable).toBe(false);
    expect((rec.detail as { stage?: string }).stage).toBe("resolve-arg");
    expect(existsSync(outside)).toBe(false); // NO out-of-root write
    expect(existsSync(outsideTxt)).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  test("MUST still ACCEPT path-free read-only commands (no over-reject)", () => {
    const inner = realpathSync(mkdtempSync(join(tmpdir(), "sli-s2ok-")));
    spawnSync("git", ["init", "-q"], { cwd: inner });
    spawnSync("git", ["config", "user.email", "x@x"], { cwd: inner });
    spawnSync("git", ["config", "user.name", "x"], { cwd: inner });
    writeFileSync(join(inner, "a.txt"), "one\n");
    spawnSync("git", ["add", "."], { cwd: inner });
    spawnSync("git", ["commit", "-q", "-m", "x"], { cwd: inner });
    writeFileSync(join(inner, "a.txt"), "two\n");
    for (const cmd of ["git diff", "git diff --stat"]) {
      const rec = reproduce(
        { type: "command", cmd, expectExit: 0, mustMatch: { kind: "substring", value: "a.txt" } },
        inner,
      );
      expect(rec.reachable).toBe(true);
    }
    // `git log --oneline` has no path value → not contained, runs fine.
    expect(validateCommand("git log --oneline").ok).toBe(true);
    rmSync(inner, { recursive: true, force: true });
  });
});

// S4 (Wave 7.1) — W7 gated grep's symlink flags and steered recursion to rg, but
// left rg's OWN `--follow`/`-L` open: ripgrep does not follow symlinks by default,
// but `--follow` re-enables it, so an in-root symlink whose realpath is OUTSIDE
// the root is read again (VERIFIED on disk: `rg --follow MARKER .` read an
// out-of-root secret). rg's symlink-follow flags are now rejected at parse.
describe("S4 (Wave 7.1) — rg --follow symlink-follow flag ban", () => {
  test.each([
    "rg --follow MARKER .",
    "rg -L MARKER .",
    "rg -Ln MARKER .",
    "rg -nL MARKER .",
  ])("symlink-following rg %p is REJECTED at parse", (cmd: string) => {
    expect(validateCommand(cmd).ok).toBe(false);
  });

  test("grep parse-gap flags (--recursive, -d recurse, --directories=recurse) also rejected (honest screen)", () => {
    for (const cmd of [
      "grep --recursive pattern .",
      "grep -d recurse pattern .",
      "grep --directories recurse pattern .",
      "grep --directories=recurse pattern .",
    ]) {
      expect(validateCommand(cmd).ok).toBe(false);
    }
  });

  test("MUST still ACCEPT non-symlink-follow reads (rg . and single-file grep)", () => {
    expect(validateCommand("rg MARKER .").ok).toBe(true);
    expect(validateCommand("grep -n MARKER file").ok).toBe(true);
    expect(validateCommand("rg -n MARKER .").ok).toBe(true); // -n alone is fine
  });

  test("REPRO: `rg --follow MARKER .` does NOT read an out-of-root symlink target", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "sli-s4v-")));
    const inner = join(base, "repo");
    const outside = join(base, "outside");
    mkdirSync(inner);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "MARKER_SECRET\n");
    symlinkSync(join(outside, "secret.txt"), join(inner, "link.txt")); // in-root → outside
    writeFileSync(join(inner, "normal.txt"), "MARKER ordinary\n");
    const rec = reproduce(
      { type: "command", cmd: "rg --follow MARKER .", expectExit: 0, mustMatch: { kind: "substring", value: "MARKER_SECRET" } },
      inner,
    );
    expect(rec.reproduced).toBe(false);
    expect(rec.reachable).toBe(false);
    expect((rec.detail as { stage?: string }).stage).toBe("parse"); // rejected before exec
    rmSync(base, { recursive: true, force: true });
  });
});

// S6 (Wave 7.1) — two adjacent vectors: (a) nested `((a+))+b` / `((a*))*b` SLIP
// because inner-frame facts were NOT propagated to the parent on group close
// (genuinely catastrophic on V8: ~429ms / ~1090ms); (b) the W7-introduced
// REGRESSION wrongly REJECTED SAFE `(?:ab)+c` / `(?<name>ab)+c` (the special-group
// `?` was miscounted as a body optional). Both are now fixed.
describe("S6 (Wave 7.1) — nested-group fact propagation + special-group prefix", () => {
  test.each(["((a+))+b", "((a*))*b", "((a?))+b", "((a*))?b", "((a|b)+)+c", "(?:a+)+b"])(
    "SLIP shape %p is now REJECTED at parse",
    (value: string) => {
      const r = parsePointer({ type: "file", path: "x", mustMatch: { kind: "regex", value } });
      expect(r.ok).toBe(false);
    },
  );

  test("the genuinely-catastrophic ((a+))+b / ((a*))*b are bounded (< 1s) via parse rejection", () => {
    for (const value of ["((a+))+b", "((a*))*b"]) {
      const t0 = performance.now();
      const r = parsePointer({ type: "file", path: "x", mustMatch: { kind: "regex", value } });
      const elapsedMs = performance.now() - t0;
      expect(r.ok).toBe(false);
      expect(elapsedMs).toBeLessThan(1000); // no event-loop burn — never compiled/run
    }
  });

  test("W7-REGRESSION GUARD: SAFE special-group shapes are NOT over-rejected", () => {
    for (const value of [
      "(?:ab)+c", // non-capture group repeat — SAFE
      "(?<name>ab)+c", // named group repeat — SAFE
      "(?=ab)c", // look-ahead
      "(?!ab)c", // negative look-ahead
      "(?<=ab)c", // look-behind
      "(?<!ab)c", // negative look-behind
    ]) {
      const r = parsePointer({ type: "file", path: "x", mustMatch: { kind: "regex", value } });
      expect(r.ok).toBe(true);
    }
  });
});
