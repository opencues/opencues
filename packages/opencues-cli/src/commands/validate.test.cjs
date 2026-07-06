// Tests for `opencues validate` — the frontmatter/config lint command.
//
// Zero prior coverage on a validator is high-risk: a false positive
// (flags a legitimate config) or false negative (misses a genuinely
// unreachable cue/blank) both go undetected without tests. This suite
// spawns the real CLI as a child process against a temp project dir
// (`--project --json`), which:
//   - avoids stubbing `process.exit` (validate calls it directly on
//     errors/--strict, which would kill an in-process test runner)
//   - is fully HOME-hermetic — every spawn gets its own tmpdir HOME
//     and only ever touches `--project` (cwd's .cues/), never `~/.cues/`
//
// Conventions follow update.integration.test.cjs (spawnSync + tmp HOME).

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CLI_BIN = path.join(REPO_ROOT, 'packages/opencues-cli/bin/cli.cjs');

let tmpHome;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-validate-test-'));
});

after(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function freshProject(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `oc-validate-proj-${name}-`));
  return dir;
}

function writeCue(projectDir, name, content) {
  const dir = path.join(projectDir, '.cues', 'cues', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CUE.md'), content);
}

function writeBlank(projectDir, name, content) {
  const dir = path.join(projectDir, '.cues', 'blanks', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'BLANK.md'), content);
}

function writeAuditor(projectDir, name, content) {
  const dir = path.join(projectDir, '.cues', 'auditors', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AUDITOR.md'), content);
}

function writeMaster(projectDir, filename, content) {
  const dir = path.join(projectDir, '.cues');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content);
}

// Run `opencues validate --project --json` against a temp project dir.
// Always HOME-isolated (tmpHome), always cwd-scoped to the project so
// the real user's ~/.cues/ is never touched or consulted (--project).
function runValidate(projectDir, extraArgs = []) {
  const res = spawnSync(
    'node',
    [CLI_BIN, 'validate', '--project', ...extraArgs],
    { cwd: projectDir, env: { ...process.env, HOME: tmpHome }, encoding: 'utf8' },
  );
  return res;
}

function runValidateJson(projectDir, extraArgs = []) {
  const res = runValidate(projectDir, ['--json', ...extraArgs]);
  let findings = null;
  try { findings = JSON.parse(res.stdout); } catch { /* leave null for assertion failure below */ }
  return { res, findings };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function rulesOf(findings) {
  return findings.map(f => f.rule);
}

// ─── Happy path ────────────────────────────────────────────────────────────

test('happy: valid cue + blank + auditor produce zero findings, exit 0', () => {
  const proj = freshProject('happy');
  try {
    writeCue(proj, 'legalish', [
      '---',
      'name: legalish',
      'scope: words',
      'priority: 70',
      'match: contract|agreement',
      '---',
      '',
      'Suggest alternatives.',
      '',
    ].join('\n'));
    writeBlank(proj, 'mybla', [
      '---',
      'name: mybla',
      'type: blank',
      'blankKeywords: mybla',
      'impl: MyBlaBlank',
      '---',
    ].join('\n'));
    writeAuditor(proj, 'grammarish', [
      '---',
      'name: grammarish',
      'description: Fix grammar',
      'priority: 50',
      '---',
      '',
      'Check for grammar issues.',
      '',
    ].join('\n'));

    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 0, `expected exit 0; stderr: ${res.stderr}`);
    assert.deepStrictEqual(findings, [], `expected zero findings, got: ${JSON.stringify(findings)}`);
  } finally {
    cleanup(proj);
  }
});

test('happy: no .cues/ directory anywhere → exit 0, empty findings', () => {
  const proj = freshProject('nodir');
  try {
    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 0);
    assert.deepStrictEqual(findings, []);
  } finally {
    cleanup(proj);
  }
});

test('happy: --help prints usage and exits 0 without scanning', () => {
  const proj = freshProject('help');
  try {
    // Plant an invalid blank — if --help scanned, it would error/exit 1.
    writeBlank(proj, 'broken', '---\nname: broken\ntype: blank\n---');
    const res = runValidate(proj, ['--help']);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /opencues validate/);
  } finally {
    cleanup(proj);
  }
});

// ─── Edge cases ────────────────────────────────────────────────────────────

test('edge: blankShapes alone (no blankKeywords) is a valid, reachable blank', () => {
  // Regression coverage for the CHANGELOG 0.2.33→0.2.34 false-positive fix:
  // blankKeywords is shorthand that desugars to blankShapes; a blank
  // declaring blankShapes directly must not be flagged as unreachable.
  const proj = freshProject('shapesonly');
  try {
    writeBlank(proj, 'shaped', [
      '---',
      'name: shaped',
      'type: blank',
      'blankShapes: ["set volume to _"]',
      'impl: ShapedBlank',
      '---',
    ].join('\n'));
    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 0);
    assert.ok(
      !rulesOf(findings).includes('blank-missing-keywords'),
      `expected no blank-missing-keywords finding, got: ${JSON.stringify(findings)}`,
    );
  } finally {
    cleanup(proj);
  }
});

test('edge: static (JSON tip-group) cue needs neither match: nor keywords:', () => {
  const proj = freshProject('static');
  try {
    writeCue(proj, 'static-words', [
      '---',
      'name: static-words',
      '---',
      '',
      '```json',
      '{"words": {"foo": {"tip": "example", "alts": ["a","b"]}}}',
      '```',
      '',
    ].join('\n'));
    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 0);
    assert.deepStrictEqual(findings, []);
  } finally {
    cleanup(proj);
  }
});

test('edge: sentence-scope cue needs neither match: nor keywords:', () => {
  const proj = freshProject('sentence');
  try {
    writeCue(proj, 'more-formal-ish', [
      '---',
      'name: more-formal-ish',
      'scope: sentence',
      'priority: 85',
      '---',
      '',
      'Rewrite the sentence more formally.',
      '',
    ].join('\n'));
    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 0);
    assert.ok(
      !rulesOf(findings).includes('cue-missing-trigger'),
      `expected no cue-missing-trigger for scope:sentence, got: ${JSON.stringify(findings)}`,
    );
  } finally {
    cleanup(proj);
  }
});

test('edge: custom (non-default) endpoint on a known provider is a warning, not an error', () => {
  const proj = freshProject('customendpoint');
  try {
    writeCue(proj, 'customep', [
      '---',
      'name: customep',
      'match: foo',
      'provider: groq',
      'endpoint: https://custom.example/v1',
      '---',
      '',
      'test prompt',
      '',
    ].join('\n'));
    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 0, 'custom endpoint is only a warning, exit stays 0 without --strict');
    const f = findings.find(x => x.rule === 'endpoint-custom');
    assert.ok(f, `expected an endpoint-custom finding, got: ${JSON.stringify(findings)}`);
    assert.strictEqual(f.severity, 'warn');
  } finally {
    cleanup(proj);
  }
});

test('edge: --strict promotes warnings to a nonzero exit', () => {
  const proj = freshProject('strict');
  try {
    // blank-script-not-executable / blank-sandbox-unset are warn-level;
    // easiest reliable warn to trigger cross-platform is host-compat-empty.
    writeCue(proj, 'unreachablehost', [
      '---',
      'name: unreachablehost',
      'match: foo',
      'on-host: [claude-code]',
      'not-on-host: [claude-code]',
      '---',
      '',
      'test',
      '',
    ].join('\n'));
    const plain = runValidate(proj);
    assert.strictEqual(plain.status, 0, 'warnings alone do not fail without --strict');
    const strict = runValidate(proj, ['--strict']);
    assert.strictEqual(strict.status, 1, '--strict must turn warnings into a failing exit code');
  } finally {
    cleanup(proj);
  }
});

test('edge: missing explicit name: field still flags cue-missing-name even though folder name is usable as a key', () => {
  const proj = freshProject('noname');
  try {
    writeCue(proj, 'somefolder', [
      '---',
      'match: foo',
      '---',
      '',
      'test',
      '',
    ].join('\n'));
    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 1);
    const f = findings.find(x => x.rule === 'cue-missing-name');
    assert.ok(f, `expected cue-missing-name, got: ${JSON.stringify(findings)}`);
    assert.strictEqual(f.severity, 'error');
  } finally {
    cleanup(proj);
  }
});

// ─── Invalid input ─────────────────────────────────────────────────────────

test('invalid: malformed master CUES.md frontmatter is flagged master-malformed', () => {
  const proj = freshProject('malformedmaster');
  try {
    writeMaster(proj, 'CUES.md', '---\n: not: valid: yaml:::\n---\n');
    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 1);
    assert.ok(
      findings.some(f => f.rule === 'master-malformed' && f.severity === 'error'),
      `expected master-malformed error, got: ${JSON.stringify(findings)}`,
    );
  } finally {
    cleanup(proj);
  }
});

test('invalid: blank with neither blankKeywords nor blankShapes is unreachable', () => {
  const proj = freshProject('nokeyword');
  try {
    writeBlank(proj, 'nokeyword', [
      '---',
      'name: nokeyword',
      'type: blank',
      'impl: NoKeywordBlank',
      '---',
    ].join('\n'));
    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 1);
    const f = findings.find(x => x.rule === 'blank-missing-keywords');
    assert.ok(f, `expected blank-missing-keywords, got: ${JSON.stringify(findings)}`);
    assert.strictEqual(f.severity, 'error');
  } finally {
    cleanup(proj);
  }
});

test('invalid: blank declaring both stepValues and blankScript (multiple binding profiles)', () => {
  const proj = freshProject('multibind');
  try {
    const blankDir = path.join(proj, '.cues', 'blanks', 'multibind');
    fs.mkdirSync(blankDir, { recursive: true });
    fs.writeFileSync(path.join(blankDir, 'BLANK.md'), [
      '---',
      'name: multibind',
      'type: blank',
      'blankKeywords: multibind',
      'stepValues: ["a","b","c"]',
      'blankScript: ./run.sh',
      '---',
    ].join('\n'));
    fs.writeFileSync(path.join(blankDir, 'run.sh'), '#!/usr/bin/env bash\necho ok\n');
    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 1);
    const f = findings.find(x => x.rule === 'blank-multiple-bindings');
    assert.ok(f, `expected blank-multiple-bindings, got: ${JSON.stringify(findings)}`);
    assert.strictEqual(f.severity, 'error');
  } finally {
    cleanup(proj);
  }
});

test('invalid: blankScript pointing at a nonexistent file', () => {
  const proj = freshProject('missingscript');
  try {
    writeBlank(proj, 'missingscript', [
      '---',
      'name: missingscript',
      'type: blank',
      'blankKeywords: missingscript',
      'blankScript: ./does-not-exist.sh',
      '---',
    ].join('\n'));
    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 1);
    const f = findings.find(x => x.rule === 'blank-script-missing');
    assert.ok(f, `expected blank-script-missing, got: ${JSON.stringify(findings)}`);
    assert.strictEqual(f.severity, 'error');
  } finally {
    cleanup(proj);
  }
});

test('invalid: word-cue with neither match: nor keywords: is unreachable at runtime', () => {
  const proj = freshProject('notrigger');
  try {
    writeCue(proj, 'notrigger', [
      '---',
      'name: notrigger',
      'scope: words',
      'priority: 50',
      '---',
      '',
      'Some prompt text with no match or keywords declared.',
      '',
    ].join('\n'));
    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 1);
    const f = findings.find(x => x.rule === 'cue-missing-trigger');
    assert.ok(f, `expected cue-missing-trigger, got: ${JSON.stringify(findings)}`);
    assert.strictEqual(f.severity, 'error');
  } finally {
    cleanup(proj);
  }
});

test('invalid: unknown provider in provider: field is an invalid endpoint', () => {
  const proj = freshProject('badprovider');
  try {
    writeCue(proj, 'badprovider', [
      '---',
      'name: badprovider',
      'match: foo',
      'provider: bogus-provider-xyz',
      '---',
      '',
      'test prompt',
      '',
    ].join('\n'));
    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 1);
    const f = findings.find(x => x.rule === 'endpoint-invalid');
    assert.ok(f, `expected endpoint-invalid, got: ${JSON.stringify(findings)}`);
    assert.strictEqual(f.severity, 'error');
  } finally {
    cleanup(proj);
  }
});

test('invalid: spec: opencues/9.9 is newer than this runtime supports', () => {
  const proj = freshProject('specnew');
  try {
    writeCue(proj, 'futurespec', [
      '---',
      'name: futurespec',
      'spec: opencues/9.9',
      'match: foo',
      '---',
      '',
      'test',
      '',
    ].join('\n'));
    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 1);
    const f = findings.find(x => x.rule === 'spec-too-new');
    assert.ok(f, `expected spec-too-new, got: ${JSON.stringify(findings)}`);
    assert.strictEqual(f.severity, 'error');
  } finally {
    cleanup(proj);
  }
});

test('invalid: unknown host name in on-host: is flagged as a typo', () => {
  const proj = freshProject('unknownhost');
  try {
    writeCue(proj, 'typoedhost', [
      '---',
      'name: typoedhost',
      'match: foo',
      'on-host: [typo-host]',
      '---',
      '',
      'test',
      '',
    ].join('\n'));
    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 1);
    const f = findings.find(x => x.rule === 'unknown-host');
    assert.ok(f, `expected unknown-host, got: ${JSON.stringify(findings)}`);
    assert.strictEqual(f.severity, 'error');
  } finally {
    cleanup(proj);
  }
});

test('invalid: empty AUDITOR.md body declares no concern (auditor would no-op)', () => {
  const proj = freshProject('emptyauditor');
  try {
    writeAuditor(proj, 'emptyauditor', [
      '---',
      'name: emptyauditor',
      '---',
      '',
      '',
    ].join('\n'));
    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 1);
    const f = findings.find(x => x.rule === 'auditor-empty-body');
    assert.ok(f, `expected auditor-empty-body, got: ${JSON.stringify(findings)}`);
    assert.strictEqual(f.severity, 'error');
  } finally {
    cleanup(proj);
  }
});

test('invalid: an empty blank/cue folder (no BLANK.md/CUE.md at all) is flagged source-empty-folder', () => {
  const proj = freshProject('emptyfolder');
  try {
    fs.mkdirSync(path.join(proj, '.cues', 'blanks', 'ghost'), { recursive: true });
    const { res, findings } = runValidateJson(proj);
    assert.strictEqual(res.status, 0, 'source-empty-folder is warn-level, not error');
    const f = findings.find(x => x.rule === 'source-empty-folder');
    assert.ok(f, `expected source-empty-folder, got: ${JSON.stringify(findings)}`);
    assert.strictEqual(f.severity, 'warn');
  } finally {
    cleanup(proj);
  }
});
