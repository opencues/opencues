// Tests for the end-of-install key-detection report.
// Run: node --test src/commands/install.keyreport.test.cjs
//
// Hermeticity: HOME is redirected to a mkdtemp dir and every provider
// env var is saved/cleared/restored — the report must never read the
// real ~/.cues/.env or the developer's shell keys.

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const { printKeyDetectionReport } = require('./install.cjs');
const { listProviders } = require(path.join(REPO_ROOT, 'packages/opencues-core/dist/llm-provider.js'));

const ALL_ENV_KEYS = listProviders().map((p) => p.envKeyName).filter(Boolean);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

let tmpHome;
const savedEnv = {};
let lines;
let origLog;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencues-keyreport-'));
  savedEnv.HOME = process.env.HOME;
  savedEnv.USERPROFILE = process.env.USERPROFILE;
  savedEnv.PATH = process.env.PATH;
  process.env.HOME = tmpHome;
  delete process.env.USERPROFILE;
  for (const k of ALL_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  lines = [];
  origLog = console.log;
  console.log = (...args) => lines.push(stripAnsi(args.join(' ')));
});

afterEach(() => {
  console.log = origLog;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('printKeyDetectionReport', () => {
  it('zero keys → "none found" + set-key pointer (and never throws)', () => {
    printKeyDetectionReport({ REPO_ROOT });
    const out = lines.join('\n');
    assert.match(out, /LLM keys/);
    assert.match(out, /none found/);
    assert.match(out, /opencues set-key/);
    assert.match(out, /~\/\.cues\/\.env/);
  });

  it('detected keys → ONE line naming the provider in use + its key source', () => {
    process.env.GROQ_API_KEY = 'gsk_shell_secret';
    fs.mkdirSync(path.join(tmpHome, '.cues'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.cues', '.env'), 'CEREBRAS_API_KEY=csk_file_secret\n', { mode: 0o600 });

    printKeyDetectionReport({ REPO_ROOT });
    const content = lines.filter((l) => l.trim() !== '');
    // Single line, resolution only — no key names or sources (presence
    // isn't validity; check-keys verifies, doctor inventories).
    assert.strictEqual(content.length, 1, `expected one report line, got:\n${content.join('\n')}`);
    // cerebras leads PROVIDER_AUTO_ORDER, so it is the pick even though
    // its key came from the file.
    assert.match(content[0], /LLM provider: cerebras\s*$/);
    assert.ok(!content[0].includes('API_KEY'), 'no key names on the resolution line');
    assert.ok(!content[0].includes('secret'), 'report must never print key material');
  });

  it('explicit llm-provider: scalar wins over the auto pick', () => {
    process.env.GROQ_API_KEY = 'gsk_shell';
    process.env.OPENAI_API_KEY = 'oa_shell';
    fs.mkdirSync(path.join(tmpHome, '.cues'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.cues', 'OPENCUES.md'), '---\nllm-provider: openai\n---\n');

    printKeyDetectionReport({ REPO_ROOT });
    const out = lines.join('\n');
    assert.match(out, /LLM provider: openai\s*$/m);
  });

  it('subscription-CLI scalar + zero env keys → resolution line, NOT the "none found" warning', () => {
    // A claude-code-cli setup is keyless by design — "LLM cues/blanks
    // stay inert" would be false and alarming here.
    fs.mkdirSync(path.join(tmpHome, '.cues'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.cues', 'OPENCUES.md'), '---\nllm-provider: claude-code-cli\n---\n');

    printKeyDetectionReport({ REPO_ROOT });
    const out = lines.join('\n');
    assert.match(out, /LLM provider: claude-code-cli\s*$/m);
    assert.ok(!out.includes('none found'));
    assert.ok(!out.includes('set-key'));
  });

  it('subscription-CLI scalar wins even when env keys exist', () => {
    process.env.GROQ_API_KEY = 'gsk_shell';
    fs.mkdirSync(path.join(tmpHome, '.cues'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.cues', 'OPENCUES.md'), '---\nllm-provider: claude-code-cli\n---\n');

    printKeyDetectionReport({ REPO_ROOT });
    const out = lines.join('\n');
    assert.match(out, /LLM provider: claude-code-cli\s*$/m);
    assert.ok(!out.includes('groq'));
  });

  it('zero keys + subscription binary on PATH → that zero-key option line appears', () => {
    // Machine-independent: a fake `claude` shim in a controlled PATH.
    const binDir = path.join(tmpHome, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = binDir;

    printKeyDetectionReport({ REPO_ROOT });
    const out = lines.join('\n');
    assert.match(out, /none found/);
    assert.match(out, /claude detected .*llm-provider: claude-code-cli/);
    assert.ok(!out.includes('codex'), 'codex is not on the controlled PATH — its line must not print');
  });

  it('zero keys + empty PATH → no subscription option lines', () => {
    const emptyDir = path.join(tmpHome, 'emptybin');
    fs.mkdirSync(emptyDir, { recursive: true });
    process.env.PATH = emptyDir;

    printKeyDetectionReport({ REPO_ROOT });
    const out = lines.join('\n');
    assert.match(out, /none found/);
    assert.ok(!out.includes('zero-key option'));
  });

  it('explicit scalar with no key for it → one warn pointing at check-keys', () => {
    process.env.GROQ_API_KEY = 'gsk_shell';
    fs.mkdirSync(path.join(tmpHome, '.cues'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.cues', 'OPENCUES.md'), '---\nllm-provider: openai\n---\n');

    printKeyDetectionReport({ REPO_ROOT });
    const out = lines.join('\n');
    assert.match(out, /LLM provider: openai .*no key detected/);
    assert.match(out, /check-keys/);
  });
});
