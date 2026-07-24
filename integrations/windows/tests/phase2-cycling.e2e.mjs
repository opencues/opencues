// Phase-2 wire e2e: cycling + render pushes + per-field profiles over the
// REAL daemon socket (fake shim, no Windows needed). This is the agentic
// counterpart to the in-runtime scenario tests — same journeys, but
// exercised through hostd's wire protocol so the daemon's focus/key/render
// plumbing is in the loop, not mocked out.
//
// Journeys:
//   A. focus a CYCLING field -> a `render` push arrives with a dim span
//      framing the cued word (tips-based LocalCueSource — no LLM).
//   B. nav chord (right) -> key-result consumed:true + render hl over the
//      word; cycle chord (up) -> set-text with the DETERMINISTIC tips alt
//      + render hl tracking the substituted word.
//   C. user types BEFORE the span -> the next render's dim span SLID by
//      the insertion delta (DynDefs.slideCharSpans over the wire) and the
//      active hl was dropped (Navigation deactivation render-kick).
//   D. focus a NON-cycling field (cycling:false) -> no dim render ever
//      arrives (word-cues pruned on the no-cycling profile) and a cycle
//      chord comes back consumed:false.
//
// LLM-free by construction: the only cue source is a `## Tips` CUES.md
// (LocalCueSource, deterministic alts), and no `_` is ever typed, so no
// blank/LLM dispatch fires. Safe for CI. Assertions follow the
// agentic-scenario rule: runtime contracts (spans, consumed flags,
// set-text arrival), never LLM content.
//
// Run: node integrations/windows/tests/phase2-cycling.e2e.mjs
// (spawns its own daemon on port 51801; safe alongside a live one on 51789)

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 51801;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const hostd = path.join(repoRoot, 'integrations', 'windows', 'src', 'hostd.cjs');

// ── Isolated config: tips-only cues, nothing else ──────────────────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-win-e2e-'));
const tips = {
  domain: 'e2e', version: 1,
  concepts: [{
    id: 'words',
    words: {
      attorney: { tip: '', alts: ['lawyer', 'legal eagle'] },
      word: { tip: '', alts: ['term'] },
    },
  }],
};
fs.writeFileSync(path.join(home, 'CUES.md'),
  `# e2e fixture\n\n## Tips\n\`\`\`json\n${JSON.stringify(tips)}\n\`\`\`\n`);
fs.writeFileSync(path.join(home, 'OPENCUES.md'), 'settings:\n');

const daemon = spawn('node', [hostd], {
  env: { ...process.env, OPENCUES_WIN_PORT: String(PORT), OPENCUES_HOME: home, OPENCUES_LOG: path.join(home, "e2e.log") },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let daemonOut = '';
daemon.stdout.on('data', (d) => { daemonOut += d; });
daemon.stderr.on('data', (d) => { daemonOut += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const s = net.connect(PORT, '127.0.0.1');
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      });
    } catch { await sleep(250); }
  }
  throw new Error('daemon never listened on ' + PORT + '\n--- daemon output ---\n' + daemonOut);
}

const sock = await connect();
// Every inbound message is ARCHIVED, never discarded: multiple frames land
// in one burst (set-text arrives BEFORE the key-result for the same chord),
// so a drain-and-drop wait would eat frames a later assertion needs.
const archive = [];
let buf = '';
sock.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try { archive.push(JSON.parse(line)); } catch { /* ignore */ }
  }
});
const send = (obj) => sock.write(JSON.stringify(obj) + '\n');
const mark = () => archive.length;   // snapshot BEFORE triggering an action

// First message at index >= from matching `pred`; waits for new arrivals.
async function waitFor(pred, timeoutMs, label, from = 0) {
  const start = Date.now();
  let i = from;
  for (;;) {
    for (; i < archive.length; i++) {
      if (pred(archive[i])) return archive[i];
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${label}\n--- daemon output tail ---\n${daemonOut.slice(-2000)}`);
    }
    await sleep(50);
  }
}

// Assert NO message at index >= from matches `pred` within `windowMs`.
async function expectSilence(pred, windowMs, label, from = 0) {
  const start = Date.now();
  let i = from;
  while (Date.now() - start < windowMs) {
    for (; i < archive.length; i++) {
      if (pred(archive[i])) throw new Error(`unexpected ${label}: ${JSON.stringify(archive[i])}`);
    }
    await sleep(50);
  }
}

let failures = 0;
function check(name, ok, detail) {
  if (ok) { console.log('  ok  ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const hasDimOver = (m, text, word) => m.t === 'render' && Array.isArray(m.dim)
  && m.dim.some(([s, e]) => text.slice(s, e) === word);
let keyId = 0;
const chord = (key) => {
  keyId++;
  send({ t: 'key', id: keyId, key, mods: { ctrl: true, alt: true, shift: false, meta: false } });
  return keyId;
};

try {
  // ── Handshake ────────────────────────────────────────────────────────────
  send({ t: 'hello', version: '0.0.0-e2e', os: 'windows' });
  const welcome = await waitFor((m) => m.t === 'welcome', 10000, 'welcome');
  check('handshake: welcome with protocol 1', welcome.protocol === 1, JSON.stringify(welcome.protocol));

  // ── A. cycling field focus -> dim render over the cued word ─────────────
  const TEXT1 = 'the attorney filed';
  send({ t: 'focus', app: 'e2eapp', text: TEXT1, cursor: TEXT1.length, cycling: true, fieldId: 101 });
  const dimPush = await waitFor((m) => hasDimOver(m, TEXT1, 'attorney'), 15000, 'dim render over "attorney"');
  check('A: dim span frames the cued word', true);
  check('A: no active hl before any nav', dimPush.hl === null || dimPush.hl === undefined,
    JSON.stringify(dimPush.hl));

  // ── B. nav chord -> hl; cycle chord -> deterministic substitution ────────
  const navId = chord('right');
  const navRes = await waitFor((m) => m.t === 'key-result' && m.id === navId, 5000, 'nav key-result');
  check('B: nav chord consumed', navRes.consumed === true);
  await waitFor((m) => m.t === 'render' && Array.isArray(m.hl) && TEXT1.slice(m.hl[0], m.hl[1]) === 'attorney',
    5000, 'hl render over "attorney"');
  check('B: hl render frames the navigated word', true);

  const preCycle = mark();
  const cycId = chord('up');
  const cycRes = await waitFor((m) => m.t === 'key-result' && m.id === cycId, 5000, 'cycle key-result');
  check('B: cycle chord consumed', cycRes.consumed === true);
  const TEXT2 = 'the lawyer filed';
  const sub = await waitFor((m) => m.t === 'set-text', 5000, 'substitution set-text', preCycle);
  check('B: substitution is the deterministic tips alt', sub.text === TEXT2, JSON.stringify(sub.text));
  await waitFor((m) => m.t === 'render' && Array.isArray(m.hl) && TEXT2.slice(m.hl[0], m.hl[1]) === 'lawyer',
    5000, 'hl render over "lawyer"', preCycle);
  check('B: hl tracks the substituted word', true);

  // ── C. user types BEFORE the span -> span slides + hl drops ─────────────
  const preEdit = mark();
  const TEXT3 = 'xx ' + TEXT2;   // insertion entirely before the span
  send({ t: 'text', text: TEXT3, cursor: 3 });
  const slid = await waitFor((m) => hasDimOver(m, TEXT3, 'lawyer'), 8000, 'slid dim render over "lawyer"', preEdit);
  check('C: dim span slid across the before-edit', true);
  check('C: active hl dropped on the user edit (deactivation kick)',
    slid.hl === null || slid.hl === undefined, JSON.stringify(slid.hl));

  // ── D. non-cycling field: no cue renders, chords not consumed ────────────
  send({ t: 'blur', app: 'e2eapp' });
  await sleep(300);
  const preNoCycling = mark();
  const TEXT4 = 'the attorney filed';
  send({ t: 'focus', app: 'plainapp', text: TEXT4, cursor: TEXT4.length, cycling: false, fieldId: 202 });
  await expectSilence((m) => hasDimOver(m, TEXT4, 'attorney'), 4000, 'dim render on a no-cycling field', preNoCycling);
  check('D: no word-cue render on the no-cycling profile', true);
  const offId = chord('up');
  const offRes = await waitFor((m) => m.t === 'key-result' && m.id === offId, 5000, 'no-cycling key-result');
  check('D: cycle chord not consumed on a no-cycling field', offRes.consumed === false,
    JSON.stringify(offRes.consumed));
} catch (err) {
  failures++;
  console.log('  FAIL ' + (err && err.message ? err.message.split('\n')[0] : String(err)));
} finally {
  try { sock.destroy(); } catch { /* ignore */ }
  try { daemon.kill(); } catch { /* ignore */ }
  if (failures > 0) { try { console.log("--- daemon log tail ---\n" + fs.readFileSync(path.join(home, "e2e.log"), "utf8").split("\n").slice(-40).join("\n")); } catch { /* ignore */ } }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failures > 0) {
  console.log(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log('\nall phase-2 wire e2e journeys hold.');
