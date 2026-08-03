// Tests for `opencues extract-commitments` — Stage A producer.
// Hermetic: OPENCUES_HOME points at a temp dir, and every provider key is
// cleared for the whole file so no test can make a real LLM call (the --force
// path lands on the "no cues-bucket LLM resolvable" skip instead).

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ctx = { REPO_ROOT };

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-extract-test-'));
const realOpencuesHome = process.env.OPENCUES_HOME;
process.env.OPENCUES_HOME = tmpHome;

const PROVIDER_KEYS = ['GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'CEREBRAS_API_KEY', 'OPENROUTER_API_KEY'];
const savedKeys = {};

const extract = require('./extract-commitments.cjs');

before(() => { for (const k of PROVIDER_KEYS) { savedKeys[k] = process.env[k]; delete process.env[k]; } });
after(() => {
  for (const k of PROVIDER_KEYS) { if (savedKeys[k] === undefined) delete process.env[k]; else process.env[k] = savedKeys[k]; }
  if (realOpencuesHome === undefined) delete process.env.OPENCUES_HOME; else process.env.OPENCUES_HOME = realOpencuesHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});
beforeEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(tmpHome, { recursive: true });
});

// Capture the --json summary line.
async function run(args) {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let code;
  try { code = await extract([...args, '--json'], ctx); } finally { console.log = orig; }
  let json = null;
  try { json = JSON.parse(logs[logs.length - 1]); } catch { /* non-json */ }
  return { code, json };
}

// `pinProvider` pins the cues bucket to a keyless HTTP provider (openai) so
// LLM resolution deterministically lands on keyPresent=false — no auto-fallback
// to the local subscription CLI, so no real network call in the test.
function writeMode(on, pinProvider) {
  let md = `session-contradiction-mode: ${on ? 'on' : 'off'}\n`;
  if (pinProvider) md += `cues-llm-provider: openai\n`;
  fs.writeFileSync(path.join(tmpHome, 'OPENCUES.md'), md);
}
function writeTranscript(name, lines) { const p = path.join(tmpHome, name); fs.writeFileSync(p, lines.join('\n')); return p; }

test('missing transcript path → exit 2', async () => {
  const { code, json } = await run([]);
  assert.strictEqual(code, 2);
  assert.strictEqual(json.ok, false);
});

test('nonexistent transcript → skip', async () => {
  const { code, json } = await run([path.join(tmpHome, 'nope.jsonl')]);
  assert.strictEqual(code, 0);
  assert.strictEqual(json.skipped, true);
  assert.match(json.reason, /not found/);
});

test('mode off → skip without touching the LLM', async () => {
  writeMode(false);
  const tp = writeTranscript('t.jsonl', ['{"type":"user","message":{"role":"user","content":"use bun"}}']);
  const { json } = await run([tp]);
  assert.strictEqual(json.skipped, true);
  assert.match(json.reason, /off/);
});

test('mode on, no text turns → skip + writes debounce marker', async () => {
  writeMode(true);
  // Only tool noise → extractTranscriptTurns yields nothing.
  const tp = writeTranscript('t.jsonl', ['{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{}}]}}']);
  const { json } = await run([tp]);
  assert.strictEqual(json.skipped, true);
  assert.match(json.reason, /no text turns/);
  assert.ok(fs.existsSync(path.join(tmpHome, '.session-commitments.marker.json')), 'marker written so we do not re-try every tick');
});

test('debounce: an unchanged transcript is skipped on the second run', async () => {
  writeMode(true);
  const tp = writeTranscript('t.jsonl', ['{"type":"user","message":{"role":"user","content":"use bun not node"}}']);
  // First run has no key → lands on the no-LLM skip, but still records the marker? No —
  // the no-LLM skip returns before writing the marker. So seed the marker directly to
  // exercise the debounce branch deterministically.
  const st = fs.statSync(tp);
  fs.writeFileSync(path.join(tmpHome, '.session-commitments.marker.json'), JSON.stringify({ transcriptPath: tp, mtimeMs: st.mtimeMs, extractedAt: Date.now() }));
  const { json } = await run([tp]);
  assert.strictEqual(json.skipped, true);
  assert.match(json.reason, /unchanged|debounced/);
});

test('mode on + turns but no provider key → skip (no LLM resolvable), no output file', async () => {
  writeMode(true, /* pinProvider */ true);
  const tp = writeTranscript('t.jsonl', ['{"type":"user","message":{"role":"user","content":"use bun not node, no new deps"}}']);
  const { code, json } = await run([tp]);
  assert.strictEqual(code, 0);
  assert.strictEqual(json.skipped, true);
  assert.match(json.reason, /no cues-bucket LLM/);
  assert.ok(!fs.existsSync(path.join(tmpHome, 'session-commitments.json')), 'no watchlist written without an LLM');
});

test('--force bypasses the mode gate (still skips on no key, proving the gate was passed)', async () => {
  writeMode(false, /* pinProvider */ true); // gate would normally stop us
  const tp = writeTranscript('t.jsonl', ['{"type":"user","message":{"role":"user","content":"use bun not node"}}']);
  const { json } = await run([tp, '--force']);
  // With --force we pass the mode + debounce gates and reach LLM resolution,
  // which fails on the keyless pinned provider → this reason proves we got past the gate.
  assert.strictEqual(json.skipped, true);
  assert.match(json.reason, /no cues-bucket LLM/);
});
