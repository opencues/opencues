// Tests for `opencues models` — pure inspection: reads OPENCUES.md
// scalars + the env key bag, renders effective routing + the provider
// catalog via @opencues/core's resolveEffectiveRouting (the shared
// dispatch walk — precedence itself is pinned in core's
// effective-routing.test.ts; these tests pin the CLI surface).
//
// Hermeticity: HOME/USERPROFILE point at a fresh mkdtemp per test (the
// command reads ~/.cues/OPENCUES.md and env-keys reads ~/.cues/.env);
// every provider env key is stripped and re-seeded per fixture; the
// subscription-CLI binary probe is seeded OFF so results don't depend
// on the dev box having `claude`/`codex` on PATH.

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const models = require('./models.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const providersMod = require(path.join(REPO_ROOT, 'packages/opencues-core/dist/llm-provider.js'));

const KEY_ENVS = providersMod.listProviders()
  .map((p) => p.envKeyName)
  .filter(Boolean);

let tmpHome;
let savedEnv;
let logs;
let origLog;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-models-test-'));
  savedEnv = {};
  for (const k of ['HOME', 'USERPROFILE', 'OPENCUES_HOME', ...KEY_ENVS]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  providersMod.setCliAvailabilityForTests('claude-code-cli', false);
  providersMod.setCliAvailabilityForTests('openai-subscription', false);
  logs = [];
  origLog = console.log;
  console.log = (...a) => logs.push(stripAnsi(a.join(' ')));
});

afterEach(() => {
  console.log = origLog;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  providersMod.resetCliAvailabilityCacheForTests();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeSettings(frontmatter) {
  const dir = path.join(tmpHome, '.cues');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'OPENCUES.md'), `---\n${frontmatter}\n---\n`);
}

function out() { return logs.join('\n'); }

describe('opencues models — happy path', () => {
  it('happy: renders effective routing per bucket from OPENCUES.md + env keys', () => {
    writeSettings('llm-provider: cerebras');
    process.env.CEREBRAS_API_KEY = 'k';
    const code = models([], { REPO_ROOT });
    assert.strictEqual(code, 0);
    assert.match(out(), /Effective routing/);
    for (const bucket of ['cues:', 'auditors:', 'blanks:']) {
      const line = logs.find((l) => l.includes(bucket));
      assert.ok(line, `expected a ${bucket} row`);
      assert.match(line, /cerebras · gpt-oss-120b/);
      assert.match(line, /← llm-provider/);
    }
  });

  it('happy: catalog puts the current provider first with the active model starred', () => {
    writeSettings('llm-provider: cerebras');
    process.env.CEREBRAS_API_KEY = 'k';
    models([], { REPO_ROOT });
    const catalogStart = logs.findIndex((l) => l.includes('Providers · models'));
    assert.ok(catalogStart >= 0);
    const rows = logs.slice(catalogStart + 1).filter((l) => l.trim().startsWith('●'));
    assert.match(rows[0], /cerebras/);
    assert.match(rows[0], /gpt-oss-120b\*/);
    assert.match(rows[0], /· current/);
    // A keyless provider is tagged and sorted below key-set ones.
    const gemini = rows.find((l) => l.includes(' gemini'));
    assert.match(gemini, /· no key/);
  });

  it('happy: bucket pinned + missing key is flagged, never silent', () => {
    writeSettings('blanks-llm-provider: gemini\nllm-provider: cerebras');
    process.env.CEREBRAS_API_KEY = 'k';
    models([], { REPO_ROOT });
    const blanksLine = logs.find((l) => l.includes('blanks:'));
    assert.match(blanksLine, /gemini · gemini-3\.1-flash-lite/);
    assert.match(blanksLine, /key missing/);
  });

  it('happy: zero keys + nothing configured → named none rows', () => {
    const code = models([], { REPO_ROOT });
    assert.strictEqual(code, 0);
    const cuesLine = logs.find((l) => l.includes('cues:'));
    assert.match(cuesLine, /none — no key \+ no scalar set/);
  });
});

describe('opencues models — --json', () => {
  it('happy: emits parseable routing + catalog with no ANSI', () => {
    writeSettings('llm-provider: cerebras\nblanks-llm-model: gemma-4-31b');
    process.env.CEREBRAS_API_KEY = 'k';
    const code = models(['--json'], { REPO_ROOT });
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(logs.join('\n'));
    assert.strictEqual(parsed.routing.blanks.providerId, 'cerebras');
    assert.strictEqual(parsed.routing.blanks.model, 'gemma-4-31b');
    assert.strictEqual(parsed.routing.blanks.modelSource, 'bucket');
    assert.strictEqual(parsed.routing.cues.model, 'gpt-oss-120b');
    const cerebras = parsed.providers.find((p) => p.id === 'cerebras');
    assert.ok(Array.isArray(cerebras.knownModels));
    assert.strictEqual(cerebras.keyPresent, true);
  });
});

describe('opencues models — invalid input', () => {
  it('invalid: unknown flags are ignored (still prints the report)', () => {
    process.env.CEREBRAS_API_KEY = 'k';
    const code = models(['--bogus'], { REPO_ROOT });
    assert.strictEqual(code, 0);
    assert.match(out(), /Effective routing/);
  });

  it('invalid: unbuilt core (bad REPO_ROOT) exits 1 with guidance', () => {
    const errs = [];
    const origErr = console.error;
    console.error = (...a) => errs.push(stripAnsi(a.join(' ')));
    try {
      const code = models([], { REPO_ROOT: tmpHome });
      assert.strictEqual(code, 1);
      assert.match(errs.join('\n'), /pnpm build/);
    } finally {
      console.error = origErr;
    }
  });

  it('--help prints usage and exits 0', () => {
    const code = models(['--help'], { REPO_ROOT });
    assert.strictEqual(code, 0);
    assert.match(out(), /opencues models/);
  });
});
