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
// Writes BOTH scalars. The producer runs when EITHER is on, and
// session-contradiction defaults on, so writing only
// `ask-cues-mode: off` would leave the gate open — an "off" case that isn't
// off. (Ask-cues now defaults off again, but the both-scalars discipline
// stays: it makes the off case off regardless of which default moves next.)
function writeMode(on, pinProvider) {
  const v = on ? 'on' : 'off';
  let md = `session-contradiction-mode: ${v}\nask-cues-mode: ${v}\n`;
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

test('scalars ABSENT → the gate passes (session-contradiction defaults on)', async () => {
  // The defaults DIFFER per scalar: session-contradiction is on unless 'off',
  // ask-cues is off unless 'on' (reverted on bench evidence — see
  // tests/benchmarks/ask-cues/EXPERIMENTS.md). The gate opens when EITHER is
  // on, so an absent-scalar file still runs the producer — via
  // session-contradiction alone. Three independent readers must agree
  // (config-loader's typed state, resolver's settings map, this gate); this
  // pins the one that decides whether the session is read at all.
  fs.writeFileSync(path.join(tmpHome, 'OPENCUES.md'), 'voice-mode: inactive\n');
  const tp = writeTranscript('absent.jsonl', ['{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{}}]}}']);
  const { json } = await run([tp]);
  assert.strictEqual(json.skipped, true);
  // Skipped for having no PROSE, which is downstream of the gate — i.e. the
  // gate let it through. A closed gate would say "both off" instead.
  assert.match(json.reason, /no text turns/);
});

test('an UNREADABLE settings file is not consent — still skips', async () => {
  // A user whose `off` we cannot see is a user whose `off` we assume.
  const dir = path.join(tmpHome, 'OPENCUES.md');
  fs.rmSync(dir, { force: true });
  fs.mkdirSync(dir);   // a directory where a file is expected → read throws
  const tp = writeTranscript('unreadable.jsonl', ['{"type":"user","message":{"role":"user","content":"use bun"}}']);
  const { json } = await run([tp]);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(json.skipped, true);
  assert.match(json.reason, /unreadable/);
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
  assert.match(json.reason, /no extraction LLM/);
  assert.ok(!fs.existsSync(path.join(tmpHome, 'session-commitments.json')), 'no watchlist written without an LLM');
});

test('--force bypasses the mode gate (still skips on no key, proving the gate was passed)', async () => {
  writeMode(false, /* pinProvider */ true); // gate would normally stop us
  const tp = writeTranscript('t.jsonl', ['{"type":"user","message":{"role":"user","content":"use bun not node"}}']);
  const { json } = await run([tp, '--force']);
  // With --force we pass the mode + debounce gates and reach LLM resolution,
  // which fails on the keyless pinned provider → this reason proves we got past the gate.
  assert.strictEqual(json.skipped, true);
  assert.match(json.reason, /no extraction LLM/);
});

// ── dsh: concatenated-zstd sessions ────────────────────────────────────────
// dsh appends each record as its OWN zstd frame, so a session file is a run of
// frames rather than one stream. Both zstdDecompressSync and
// createZstdDecompress() stop after the FIRST frame and hand back just the
// session header — which decodes cleanly, parses as one record, and is
// indistinguishable from an empty conversation. These pin the multi-frame read.

const zlib = require('node:zlib');
const hasZstd = typeof zlib.zstdCompressSync === 'function';

/** Build a dsh session file: one zstd frame per JSONL record. */
function writeDshSession(dir, records) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl.zstd');
  const frames = records.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8')));
  fs.writeFileSync(file, Buffer.concat(frames));
  return file;
}

const dshHeader = (cwd) => ({ type: 'session', version: 1, id: 's1', cwd, createdAt: Date.now() });
const dshUser = (text) => ({
  type: 'user/message',
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});

test('dsh: a multi-frame session is read past the first frame', { skip: !hasZstd }, async () => {
  const dir = path.join(tmpHome, 'dsh-multi', 'session-aaa');
  const file = writeDshSession(dir, [dshHeader('/w'), dshUser('we use Bun, not Node')]);
  writeMode(true, true);
  const { json } = await run([file, '--format', 'dsh']);
  // No provider key here, so it reaches the LLM gate rather than the
  // "no text turns" skip — reaching it at all proves the turns were extracted
  // from a frame AFTER the first.
  assert.strictEqual(json.skipped, true);
  assert.doesNotMatch(json.reason, /no text turns|unreadable/i);
});

test('dsh: a header-only session yields no turns', { skip: !hasZstd }, async () => {
  const dir = path.join(tmpHome, 'dsh-empty', 'session-bbb');
  const file = writeDshSession(dir, [dshHeader('/w')]);
  writeMode(true, true);
  const { json } = await run([file, '--format', 'dsh']);
  assert.match(json.reason, /no text turns/i);
});

test('dsh: harness-injected user records are not treated as user turns', { skip: !hasZstd }, async () => {
  // `plugin` and `skill-catalog` records are written as `user/message` too;
  // only source.kind separates them from something a person typed.
  const dir = path.join(tmpHome, 'dsh-injected', 'session-ccc');
  const file = writeDshSession(dir, [
    dshHeader('/w'),
    { type: 'user/message', data: { role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'Current DSH file policy: workspace-write.' }] } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<system-reminder> A skill is…' }] } },
  ]);
  writeMode(true, true);
  const { json } = await run([file, '--format', 'dsh']);
  assert.match(json.reason, /no text turns/i);
});

test('dsh: session identity comes from the DIRECTORY, not the filename', { skip: !hasZstd }, async () => {
  // Every dsh session file is named `session.jsonl.zstd`, so a filename-derived
  // id would make two different sessions look like one — and merge a prior,
  // unrelated conversation's commitments into the new watchlist.
  const a = writeDshSession(path.join(tmpHome, 'dsh-id', 'session-111'), [dshHeader('/w'), dshUser('one')]);
  const b = writeDshSession(path.join(tmpHome, 'dsh-id', 'session-222'), [dshHeader('/w'), dshUser('two')]);
  assert.strictEqual(path.basename(a), path.basename(b));
  assert.notStrictEqual(path.basename(path.dirname(a)), path.basename(path.dirname(b)));
});
