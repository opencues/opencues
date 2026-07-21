#!/usr/bin/env node
// Phase 0 spike driver: times JXA round-trips against Notes.app and prints a
// JSON report. Only touches notes inside the "OpenCues Spike" folder.
// Usage: node spike.mjs [--cleanup]

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const JXA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'spike-jxa.js');

function jxa(args, { timeoutMs = 30000 } = {}) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', JXA, ...args],
      { timeout: timeoutMs },
      (err, stdout, stderr) => {
        const ms = Date.now() - t0;
        if (err) {
          resolve({ ok: false, ms, error: String(err), stderr: stderr.trim(), code: err.code });
          return;
        }
        try {
          resolve({ ...JSON.parse(stdout.trim()), ms, stderr: stderr.trim() });
        } catch {
          resolve({ ok: false, ms, error: 'unparseable stdout', stdout: stdout.trim() });
        }
      }
    );
  });
}

async function timed(label, args, runs) {
  const times = [];
  let last = null;
  for (let i = 0; i < runs; i++) {
    last = await jxa(args);
    if (!last.ok) return { label, failed: last };
    times.push(last.ms);
  }
  times.sort((a, b) => a - b);
  return {
    label,
    runs,
    minMs: times[0],
    medianMs: times[Math.floor(times.length / 2)],
    maxMs: times[times.length - 1],
    last
  };
}

const report = { startedAt: new Date().toISOString() };

if (process.argv.includes('--cleanup')) {
  report.cleanup = await jxa(['cleanup']);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// 1. running() must not launch Notes — record state before anything else.
report.statusBefore = await jxa(['status']);

// 2. Create the spike folder + test note (this may launch Notes headlessly
//    and will trigger the Automation TCC prompt on first ever run).
report.setup = await jxa(['setup']);
if (!report.setup.ok) {
  report.verdict = 'SETUP FAILED — likely TCC denial; see stderr for -1743';
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}
const noteId = report.setup.noteId;

// 3. Read it back: body HTML shape + plaintext correspondence.
report.read = await jxa(['read', noteId]);

// 4. Latency: single-note read x10, whole-account enumeration x5.
report.readTiming = await timed('read-note', ['read', noteId], 10);
report.enumerateTiming = await timed('enumerate-all-notes', ['enumerate'], 5);

// 5. Changed-since probe (the daemon's poll shape).
const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
report.changedProbe = await jxa(['changed', since]);

// 6. CAS fill: splice the answer into the blank line, timed.
const oldLine = 'what is the capital of france _';
const newLine = 'what is the capital of france Paris';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
report.casFill = await jxa(['cas-fill', noteId, esc(oldLine), esc(newLine)]);

// 7. Zero-match conflict path: same fragment again must now be a zero-match.
report.casConflict = await jxa(['cas-fill', noteId, esc(oldLine), esc(newLine)]);

// 8. Write timing: full body set x5 on the (already modified) spike note.
if (report.read.ok) {
  report.writeTiming = await timed('write-body', ['write-body', noteId, report.casFill.ok ? '' : report.read.body], 0);
  // full-body writes timed via cas-fill instead; raw write-body left unused
  // unless needed manually — cas-fill IS the production write path.
  delete report.writeTiming;
  const casTimes = [];
  for (let i = 0; i < 5; i++) {
    const a = esc(`what is the capital of france ${i % 2 ? '_' : 'Paris'}`);
    const b = esc(`what is the capital of france ${i % 2 ? 'Paris' : '_'}`);
    const r = await jxa(['cas-fill', noteId, b, a]);
    if (r.ok) casTimes.push(r.ms);
  }
  casTimes.sort((x, y) => x - y);
  report.casTiming = {
    runs: casTimes.length,
    minMs: casTimes[0],
    medianMs: casTimes[Math.floor(casTimes.length / 2)],
    maxMs: casTimes[casTimes.length - 1]
  };
}

// 9. Final plaintext/body snapshot for the fixture library.
report.finalRead = await jxa(['read', noteId]);
report.statusAfter = await jxa(['status']);

console.log(JSON.stringify(report, null, 2));
