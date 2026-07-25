// R5 regression probe (ported lesson from the Android host): consecutive
// `_` blanks must keep firing. Android's service only forwarded `_`-bearing
// text states, so the resolver's no-`_` -> `_` transition gate stayed shut
// and every blank after the first silently died. This drives the Windows
// daemon over the real wire protocol (fake shim, no Windows needed) and
// pins the two shapes:
//
//   A. everyday consecutive fills: blank -> substitution -> more typing ->
//      second blank -> second substitution.
//   B. the pathological gate edge: a second `_` typed while the first is
//      still unresolved (both buffer states end with `_`) - the daemon's
//      underscore-count keystroke synth must still arm the second blank.
//
// LLM-dependent (uses the configured provider); assertions are decoupled
// from LLM content per the agentic-scenario rule: we assert a set-text
// stream ARRIVED and the final text DIFFERS from what was typed - never
// specific wording.
//
// Run: node integrations/windows/tests/r5-consecutive-blanks.e2e.mjs
// (spawns its own daemon on port 51800; safe alongside a live one on 51789)

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 51800;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const hostd = path.join(repoRoot, 'integrations', 'windows', 'src', 'hostd.cjs');

const daemon = spawn('node', [hostd], {
  env: { ...process.env, OPENCUES_WIN_PORT: String(PORT) },
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
const inbox = [];
let buf = '';
sock.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try { inbox.push(JSON.parse(line)); } catch { /* ignore */ }
  }
});
const send = (obj) => sock.write(JSON.stringify(obj) + '\n');

// Collect set-text frames until the stream has been quiet for quietMs.
// Returns the frames seen (empty array if none arrived before timeoutMs).
async function collectSetText(quietMs, timeoutMs) {
  const start = Date.now();
  const seen = [];
  let lastAt = null;
  for (;;) {
    while (inbox.length) {
      const m = inbox.shift();
      if (m.t === 'set-text') { seen.push(m); lastAt = Date.now(); }
    }
    if (lastAt !== null && Date.now() - lastAt > quietMs) return seen;
    if (lastAt === null && Date.now() - start > timeoutMs) return seen;
    await sleep(50);
  }
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
};

try {
  send({ t: 'hello', version: 'r5-probe', os: 'fake' });
  await sleep(300);
  check('welcome received', inbox.some((m) => m.t === 'welcome'));
  inbox.length = 0;

  // --- Scenario A: everyday consecutive fills -----------------------------
  send({ t: 'focus', app: 'r5probe', text: '', cursor: 0 });
  await sleep(200);

  const typedA1 = 'hello world make it caps _';
  send({ t: 'text', text: typedA1, cursor: typedA1.length });
  const framesA1 = await collectSetText(1500, 20000);
  const finalA1 = framesA1.length ? framesA1[framesA1.length - 1].text : null;
  check('A1: first blank produced a set-text stream', framesA1.length >= 1, `frames=${framesA1.length}`);
  check('A1: substitution changed the buffer', finalA1 !== null && finalA1 !== typedA1,
    finalA1 === null ? '' : `finalLen=${finalA1.length}`);

  if (finalA1 !== null) {
    // Field adopted the substitution; user keeps typing a SECOND blank.
    const typedA2 = finalA1 + ' now make it lowercase _';
    send({ t: 'text', text: typedA2, cursor: typedA2.length });
    const framesA2 = await collectSetText(1500, 20000);
    const finalA2 = framesA2.length ? framesA2[framesA2.length - 1].text : null;
    check('A2: SECOND consecutive blank fired', framesA2.length >= 1, `frames=${framesA2.length}`);
    check('A2: second substitution changed the buffer', finalA2 !== null && finalA2 !== typedA2);
  } else {
    check('A2: skipped (no first substitution to build on)', false);
  }

  // --- Scenario B: second `_` while the first is unresolved ---------------
  // Both resolver-visible states end with `_` (the Android R5 gate shape).
  send({ t: 'focus', app: 'r5probe', text: '', cursor: 0 });
  await sleep(200);

  const typedB1 = 'the cat sat on teh mat _';
  send({ t: 'text', text: typedB1, cursor: typedB1.length });
  await sleep(120);   // well under LLM latency: first resolve still in flight
  const typedB2 = 'the cat sat on teh mat _ and fix typos _';
  send({ t: 'text', text: typedB2, cursor: typedB2.length });
  const framesB = await collectSetText(1500, 25000);
  const finalB = framesB.length ? framesB[framesB.length - 1].text : null;
  check('B: blank fired despite prev state also ending with `_`', framesB.length >= 1, `frames=${framesB.length}`);
  check('B: substitution changed the buffer', finalB !== null && finalB !== typedB2 && finalB !== typedB1);
} finally {
  sock.destroy();
  daemon.kill('SIGTERM');
  await sleep(300);
  daemon.kill('SIGKILL');
}

if (failures) {
  console.log('\n--- daemon output (tail) ---\n' + daemonOut.split('\n').slice(-25).join('\n'));
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
