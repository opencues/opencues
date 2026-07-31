// DISMISS: the user's response to a flag. Two grains:
//   episode (default) — mute THIS claim's collisions for 24h; the
//     claim stays alive (snoozing tonight's pizza nag never kills
//     the diet).
//   --forever — retire the claim permanently (the "forget that _"
//     verb): status dormant, out of every future catalog.
// Claim addressed by id or by regex over open claims' text.
// Usage: node dismiss.mjs <id|/regex/> [--forever] [--ts iso]
import fs from 'node:fs';

const S = (f) => new URL(`./${process.env.CDI_STORE ?? 'store'}/${f}`, import.meta.url);
const args = process.argv.slice(2);
const take = (flag) => { const i = args.indexOf(flag); return i >= 0 ? (args.splice(i, 1), true) : false; };
const takeVal = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const forever = take('--forever');
const ts = takeVal('--ts') ?? new Date().toISOString();
const sel = args.join(' ');
if (!sel) { console.error('usage: dismiss.mjs <id|regex> [--forever] [--ts iso]'); process.exit(1); }

const claims = JSON.parse(fs.readFileSync(S('claims.json'), 'utf8'));
const target = /^\d+$/.test(sel)
  ? claims.find(c => c.id === Number(sel))
  : claims.find(c => (c.status === 'open' || c.status === 'pending') && new RegExp(sel, 'i').test(c.claim));
if (!target) { console.error(`no open claim matching "${sel}"`); process.exit(1); }

const dFile = S('dismissals.json');
const dismissals = fs.existsSync(dFile) ? JSON.parse(fs.readFileSync(dFile, 'utf8')) : [];
if (forever) {
  target.status = 'dormant';
  fs.writeFileSync(S('claims.json'), JSON.stringify(claims, null, 1));
  console.log(`dismissed FOREVER: #${target.id} "${target.claim}" -> dormant`);
} else {
  const until = new Date(new Date(ts).getTime() + 24 * 3600 * 1000).toISOString();
  dismissals.push({ claimId: target.id, ts, until });
  fs.writeFileSync(dFile, JSON.stringify(dismissals, null, 1));
  console.log(`dismissed (episode): #${target.id} "${target.claim}" muted until ${until}`);
}
