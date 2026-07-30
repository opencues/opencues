// Scenario runner: execute a persona week against the loop and score it.
// Scenario JSON: {"name": str, "steps": [
//   {"collect": text, "ts": iso, "to"?: who, "via"?: channel}
//   {"dream": true}
//   {"probe": text, "ts": iso, "to"?: who, "via"?: channel,
//    "expect": "FLAG"|"SILENCE", "claim"?: regex, "note"?: str}
// ]}
// Probes between dreams run concurrently (checks are read-only).
// Usage: node run-scenario.mjs scenarios/<name>.json
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const here = path.dirname(new URL(import.meta.url).pathname);
const scen = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const storeDir = `stores/${scen.name}`;
fs.rmSync(path.join(here, storeDir), { recursive: true, force: true });
fs.mkdirSync(path.join(here, storeDir), { recursive: true });
const env = { ...process.env, CDI_STORE: storeDir };
const node = async (script, args) =>
  (await exec('node', [path.join(here, script), ...args], { env })).stdout;

const ctxArgs = (s) => [
  ...(s.to ? ['--to', s.to] : []), ...(s.via ? ['--via', s.via] : []),
  ...(s.ts ? ['--ts', s.ts] : []),
];

async function runProbe(p) {
  let stdout;
  try { stdout = await node('check.mjs', [p.probe, ...ctxArgs(p)]); }
  catch (e) { return { ok: false, line: `  ✗ ERROR "${p.probe}": ${String(e.message).slice(0, 140)}` }; }
  const first = stdout.trim().split('\n')[0];
  const m = first.match(/^FLAG\s+#(\d+): "(.*)"$/);
  const got = m ? 'FLAG' : 'SILENCE';
  let ok = got === p.expect;
  if (ok && m && p.claim && !new RegExp(p.claim, 'i').test(m[2])) ok = false;
  const line = `  ${ok ? '✓' : '✗'} [want ${p.expect}${p.claim ? ' ~/' + p.claim + '/' : ''}] "${p.probe}" → ${m ? `FLAG #${m[1]} "${m[2]}"` : 'SILENCE'}${!ok && p.note ? `  (${p.note})` : ''}`;
  return { ok, line };
}

const results = [];
let block = [];
async function flush() {
  const probes = block; block = [];
  for (let i = 0; i < probes.length; i += 3) {
    const chunk = await Promise.all(probes.slice(i, i + 3).map(runProbe));
    results.push(...chunk);
    for (const r of chunk) console.log(r.line);
  }
}

for (const step of scen.steps) {
  if (step.probe) { block.push(step); continue; }
  await flush();
  if (step.collect) await node('collect.mjs', [step.collect, ...ctxArgs(step)]);
  else if (step.dream) console.log((await node('dream.mjs', [])).trim().split('\n')[0]);
}
await flush();

const passed = results.filter(r => r.ok).length;
console.log(`\n${scen.name}: ${passed}/${results.length}`);
process.exit(passed === results.length ? 0 : 1);
