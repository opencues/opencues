// COLLECT: append a submitted utterance to the raw stream.
// Usage: node collect.mjs "<text>" [--ts 2026-07-24T10:00]
import fs from 'node:fs';
const args = process.argv.slice(2);
const tsIdx = args.indexOf('--ts');
const ts = tsIdx >= 0 ? args.splice(tsIdx, 2)[1] : new Date().toISOString();
const text = args.join(' ');
if (!text) { console.error('usage: collect.mjs "<text>" [--ts iso]'); process.exit(1); }
fs.appendFileSync(new URL('./store/raw.jsonl', import.meta.url),
  JSON.stringify({ ts, text }) + '\n');
console.log('collected:', text);
