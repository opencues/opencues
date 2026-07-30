// COLLECT: append a submitted utterance to the raw stream.
// v3: stamp the thread context the host adapter already knows —
// recipient (--to) and channel (--via). Never inferred, always recorded.
// Usage: node collect.mjs "<text>" [--ts iso] [--to Ana] [--via whatsapp]
import fs from 'node:fs';
const args = process.argv.slice(2);
const take = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const ts = take('--ts') ?? new Date().toISOString();
const to = take('--to');
const via = take('--via');
const text = args.join(' ');
if (!text) { console.error('usage: collect.mjs "<text>" [--ts iso] [--to who] [--via channel]'); process.exit(1); }
fs.appendFileSync(new URL('./store/raw.jsonl', import.meta.url),
  JSON.stringify({ ts, ...(to && { to }), ...(via && { via }), text }) + '\n');
console.log(`collected${to ? ` [to ${to}${via ? ' via ' + via : ''}]` : ''}:`, text);
