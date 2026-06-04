// Spec-version gate — integration tests for the discover.ts log hook.
//
// Pins the END-TO-END behaviour the runtime depends on:
//   1. A folder-discovered source whose CUE.md / BLANK.md / AUDITOR.md
//      declares a too-new `spec:` is silently dropped from the merged
//      DiscoveredConfigs.
//   2. The optional `log` callback is invoked with a `warn`-level
//      message that mentions the offending path AND the version.
//   3. Acceptable specs flow through unchanged — no false positives.
//
// These guarantees are what ConfigLoader (runtime) relies on to
// surface refusals in `/tmp/opencues.log`. Without them, the
// spec-version gate would refuse files silently (worse than the
// pre-gate behaviour from a debuggability angle).

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { discoverFolderConfigs, type DirEntry } from './discover';

// ── Synthetic FS — minimal readFile/readDir backed by a Map ───────────
function makeFs(files: Record<string, string>): {
  readFile: (p: string) => string | null;
  readDir: (p: string) => DirEntry[] | null;
} {
  // Synthesise directory listings from the keys.
  const dirs = new Map<string, Map<string, boolean>>();  // dir → name → isDirectory
  for (const path of Object.keys(files)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      const child = parts[i];
      const isLast = i === parts.length - 1;
      if (!dirs.has(dir)) dirs.set(dir, new Map());
      dirs.get(dir)!.set(child, !isLast);
    }
  }
  return {
    readFile: (p: string) => files[p] ?? null,
    readDir: (p: string) => {
      const d = dirs.get(p);
      if (!d) return null;
      return Array.from(d.entries()).map(([name, isDirectory]) => ({ name, isDirectory }));
    },
  };
}

const TOO_NEW_CUE = `---
name: future-cue
spec: opencues/99.0
match: foo
priority: 50
---

## Prompt

prompt body
`;

const TOO_NEW_BLANK = `---
name: future-blank
spec: opencues/99.0
blankKeywords: foo
stepValues: [a, b, c]
---
`;

const TOO_NEW_AUDITOR = `---
name: future-auditor
spec: opencues/99.0
priority: 50
---

an auditor prompt body
`;

const VALID_CUE = `---
name: ok-cue
match: hello
priority: 50
---

## Prompt

valid prompt body
`;

// ────────────────────────────────────────────────────────────────────────────

describe('discoverFolderConfigs — spec-too-new refusal + log hook', () => {
  it('drops a too-new CUE.md from results and invokes log with the path + reason', () => {
    const fs = makeFs({
      '/r/cues/future/CUE.md': TOO_NEW_CUE,
    });
    const messages: { level: string; msg: string }[] = [];
    const result = discoverFolderConfigs({
      basePath: '/r',
      readFile: fs.readFile,
      readDir: fs.readDir,
      log: (level, msg) => messages.push({ level, msg }),
    });

    // The future-cue MUST NOT appear in any merged config.
    assert.deepStrictEqual(result.cuesConfig?.promptConfig?.sources ?? {}, {});
    // Exactly one warn line, mentioning the path AND the version.
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].level, 'warn');
    assert.ok(messages[0].msg.includes('/r/cues/future/CUE.md'), `path should appear in: ${messages[0].msg}`);
    assert.ok(messages[0].msg.includes('99.0'), `version should appear in: ${messages[0].msg}`);
  });

  it('drops a too-new BLANK.md and logs', () => {
    const fs = makeFs({
      '/r/blanks/future/BLANK.md': TOO_NEW_BLANK,
    });
    const messages: { level: string; msg: string }[] = [];
    const result = discoverFolderConfigs({
      basePath: '/r',
      readFile: fs.readFile,
      readDir: fs.readDir,
      log: (level, msg) => messages.push({ level, msg }),
    });

    // No blanks merged from the refused folder.
    assert.deepStrictEqual(result.blanksConfig?.blanks ?? {}, {});
    // The discover implementation scans `blanks/` twice (once for
    // blanksConfig, once for blankOverrides — pre-existing, see
    // discoverFolderConfigs:249,259). The refusal log fires once per
    // scan. That's a deliberate property of the smoke: we tolerate
    // either 1 or 2 invocations, but every invocation MUST be a warn
    // mentioning the file + version. The actual contract is "every
    // refusal is logged at least once" — not "exactly once".
    assert.ok(messages.length >= 1, `expected at least 1 log; got: ${messages.length}`);
    for (const m of messages) {
      assert.strictEqual(m.level, 'warn');
      assert.ok(m.msg.includes('BLANK.md'), `BLANK.md should appear in: ${m.msg}`);
      assert.ok(m.msg.includes('99.0'), `version should appear in: ${m.msg}`);
    }
  });

  it('drops a too-new AUDITOR.md and logs', () => {
    const fs = makeFs({
      '/r/auditors/future/AUDITOR.md': TOO_NEW_AUDITOR,
    });
    const messages: { level: string; msg: string }[] = [];
    const result = discoverFolderConfigs({
      basePath: '/r',
      readFile: fs.readFile,
      readDir: fs.readDir,
      log: (level, msg) => messages.push({ level, msg }),
    });

    assert.deepStrictEqual(result.auditorsConfig?.auditors ?? {}, {});
    assert.strictEqual(messages.length, 1);
    assert.ok(messages[0].msg.includes('AUDITOR.md'));
  });

  it('mixed too-new + valid: drops the bad one, keeps the good one', () => {
    const fs = makeFs({
      '/r/cues/future/CUE.md': TOO_NEW_CUE,
      '/r/cues/ok/CUE.md': VALID_CUE,
    });
    const messages: { level: string; msg: string }[] = [];
    const result = discoverFolderConfigs({
      basePath: '/r',
      readFile: fs.readFile,
      readDir: fs.readDir,
      log: (level, msg) => messages.push({ level, msg }),
    });

    const sources = result.cuesConfig?.promptConfig?.sources ?? {};
    assert.ok('ok-cue' in sources, `ok-cue should load; got: ${Object.keys(sources)}`);
    assert.ok(!('future-cue' in sources), 'future-cue MUST NOT load');
    // One warn for the refused source, none for the valid one.
    assert.strictEqual(messages.length, 1);
    assert.ok(messages[0].msg.includes('future/CUE.md'));
  });

  it('omitted log callback: refusal still drops the source (silent path)', () => {
    // Some callers (tests, third-party tooling) don't supply a log
    // hook. The gate MUST still refuse, just silently.
    const fs = makeFs({
      '/r/cues/future/CUE.md': TOO_NEW_CUE,
      '/r/cues/ok/CUE.md': VALID_CUE,
    });
    const result = discoverFolderConfigs({
      basePath: '/r',
      readFile: fs.readFile,
      readDir: fs.readDir,
      // log intentionally omitted
    });

    const sources = result.cuesConfig?.promptConfig?.sources ?? {};
    assert.ok('ok-cue' in sources);
    assert.ok(!('future-cue' in sources));
  });

  it('valid spec passes through with no log calls', () => {
    const fs = makeFs({
      '/r/cues/ok/CUE.md': VALID_CUE,
    });
    const messages: { level: string; msg: string }[] = [];
    const result = discoverFolderConfigs({
      basePath: '/r',
      readFile: fs.readFile,
      readDir: fs.readDir,
      log: (level, msg) => messages.push({ level, msg }),
    });

    assert.ok('ok-cue' in (result.cuesConfig?.promptConfig?.sources ?? {}));
    assert.strictEqual(messages.length, 0);
  });

  it('omitted spec frontmatter passes — back-compat invariant', () => {
    // Files predating the spec field MUST keep loading. The
    // omit-default rule (`SPEC_OMIT_DEFAULT`) makes this work; this
    // test pins that invariant against the discover layer too.
    const noSpecCue = VALID_CUE; // VALID_CUE has no spec: field
    assert.ok(!noSpecCue.includes('spec:'), 'fixture invariant — no spec field');
    const fs = makeFs({ '/r/cues/legacy/CUE.md': noSpecCue });
    const messages: { level: string; msg: string }[] = [];
    const result = discoverFolderConfigs({
      basePath: '/r',
      readFile: fs.readFile,
      readDir: fs.readDir,
      log: (level, msg) => messages.push({ level, msg }),
    });

    assert.ok('ok-cue' in (result.cuesConfig?.promptConfig?.sources ?? {}));
    assert.strictEqual(messages.length, 0);
  });
});
