// `opencues calendar` — manage calendar-context calendar feeds.
//
// Calendar-context ingests iCalendar (.ics / webcal) feeds so fluid-blank can
// answer availability (`am i free thursday _`) and the calendar-conflict cue
// can fire. Feeds live one-per-line in ~/.cues/calendar-feeds.txt; this
// command edits that file (and verifies a feed fetches + parses on `add`).
//
// One .ics parser covers Luma, Google, Outlook/M365, Apple iCloud, any feed.
//
// Usage:
//   opencues calendar add <url>        add a feed (fetches + parses to verify)
//   opencues calendar add <url> --no-verify   add without the network check
//   opencues calendar list             list feeds (with live event counts)
//   opencues calendar list --json      JSON (scriptable)
//   opencues calendar remove <url|N>   remove a feed by URL or 1-based index
//   opencues calendar --help           this help
//
// See: docs/architecture/calendar-context.md, docs/features/calendar-context.md

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { bold, dim, green, yellow, red, fileLink, banner, cliVersion, G } = require('../lib/style.cjs');

const HOME = os.homedir();
const tilde = p => (p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);
const CUES_DIR = path.join(HOME, '.cues');
const FEEDS_PATH = path.join(CUES_DIR, 'calendar-feeds.txt');
const OPENCUES_PATH = path.join(CUES_DIR, 'OPENCUES.md');

// Self-heal the July-2026 life-context → calendar-context rename: move a user's
// existing feed list + snapshot to the new names so their calendars keep working
// without re-adding. One-shot, idempotent (only fires when the OLD file exists
// and the NEW one doesn't). The .life-context-refresh trigger is ephemeral, so
// it needs no migration. See docs/features/calendar-context.md.
function migrateLegacyPaths() {
  const moves = [
    [path.join(CUES_DIR, 'life-context-feeds.txt'), FEEDS_PATH], // LEGACY-NAME-ALLOW: rename migration source
    [path.join(CUES_DIR, 'life-context.json'), path.join(CUES_DIR, 'calendar.json')], // LEGACY-NAME-ALLOW: rename migration source
  ];
  for (const [oldP, newP] of moves) {
    try {
      if (fs.existsSync(oldP) && !fs.existsSync(newP)) fs.renameSync(oldP, newP);
    } catch { /* best-effort — a failed migration must not break the command */ }
  }
}

const HEADER = [
  '# calendar-context calendar feeds — one .ics / webcal URL per line.',
  '# Lines starting with # are ignored. Managed by `opencues calendar`.',
  '# Any .ics/webcal feed works (Luma, Google, Outlook, Apple, …).',
  '# Requires `calendar-context-mode: on` in OPENCUES.md.',
  '',
].join('\n');

function tryLoadCore() {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'opencues-core', 'dist'),
    path.resolve(__dirname, '..', '..', '..', '..', 'node_modules', '@opencues', 'core', 'dist'),
  ];
  for (const c of candidates) {
    try {
      const ics = require(path.join(c, 'ics.js'));
      // calendar-sync.js carries the ONE feeds->snapshot implementation
      // (shared with the runtime refresh scheduler + chrome-host).
      let sync = {};
      try { sync = require(path.join(c, 'calendar-sync.js')); } catch {}
      return Object.assign({}, ics, sync);
    } catch {}
  }
  return null;
}

function readLines() {
  try { return fs.readFileSync(FEEDS_PATH, 'utf8').split(/\r?\n/); } catch { return null; }
}
function activeUrls(lines) {
  return (lines || []).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}
function isFeedUrl(u) { return /^(https?|webcal):\/\//i.test(u); }
function toHttp(u) { return u.replace(/^webcal:\/\//i, 'https://'); }

function calendarContextModeOn() {
  try {
    const md = fs.readFileSync(OPENCUES_PATH, 'utf8');
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return false;
    // last-wins, matching the runtime parser
    let on = false;
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^calendar-context-mode:\s*([^\n#]*)/);
      if (m) on = m[1].trim().toLowerCase() === 'on';
    }
    return on;
  } catch { return false; }
}

async function verifyFeed(url) {
  const core = tryLoadCore();
  if (!core || typeof core.parseIcs !== 'function') return { ok: null, reason: '@opencues/core not built — skipped verify' };
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(toHttp(url), { headers: { 'User-Agent': 'opencues-cli/1.0' }, redirect: 'follow', signal: ctl.signal });
    clearTimeout(to);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const text = await res.text();
    // Confirm it's actually an iCalendar feed, not an HTML page / redirect
    // landing / error body that happened to return 200.
    if (!/BEGIN:VCALENDAR/i.test(text)) {
      const ct = res.headers.get('content-type') || 'unknown';
      return { ok: false, reason: `not an iCalendar feed (no VCALENDAR block; content-type ${ct})` };
    }
    const total = (text.match(/BEGIN:VEVENT/gi) || []).length;
    const now = Date.now();
    const upcoming = core.parseIcs(text, { windowStartMs: now - 3600e3, windowEndMs: now + 60 * 24 * 3600e3, maxEvents: 200 });
    return { ok: true, total, upcoming: upcoming.length, next: upcoming[0] };
  } catch (e) { return { ok: false, reason: (e && e.message) || String(e) }; }
}

// The PRODUCER. Fetch every feed → write ~/.cues/calendar.json, the ONE
// shared snapshot every host reads (native hosts load it directly; chrome gets
// it through the config-bundle it already syncs from ~/.cues). No per-host
// poller — one file, produced here, consumed everywhere.
const SNAPSHOT_PATH = path.join(CUES_DIR, 'calendar.json');
const WINDOW_DAYS = 60;

async function buildSnapshot() {
  const core = tryLoadCore();
  if (!core || typeof core.parseIcs !== 'function') return { ok: false, reason: '@opencues/core not built' };
  // ONE implementation — core's syncCalendarFeeds (also driven by the
  // runtime refresh scheduler + chrome-host). Older cores without it
  // cannot occur here (same repo), but guard anyway.
  if (typeof core.syncCalendarFeeds !== 'function') return { ok: false, reason: '@opencues/core too old (no syncCalendarFeeds)' };
  const r = await core.syncCalendarFeeds({ fs, cuesDir: CUES_DIR, windowDays: WINDOW_DAYS, log: (m) => { if (process.env.OPENCUES_DEBUG) console.error(m); } });
  if (!r.ok) return r;
  let snap = { events: [] };
  try { snap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')); } catch { /* just synced; unlikely */ }
  const now = Date.now();
  return { ok: true, okCount: r.okCount, feeds: r.feeds, events: r.events,
           next: (snap.events || []).find(e => new Date(e.start).getTime() >= now) };
}

async function sync(silent) {
  const r = await buildSnapshot();
  if (!r.ok) { if (!silent) console.error(`opencues calendar sync: ${r.reason}`); return r.reason === 'no feeds' ? 0 : 1; }
  if (!silent) {
    console.log(`${green(G.ringOn)} synced ${r.events} event(s) from ${r.okCount}/${r.feeds} feed(s) ${dim('→ ' + tilde(SNAPSHOT_PATH))}`);
    if (r.next) console.log(`  ${dim('next: ' + r.next.title + ' ' + r.next.start)}`);
    console.log(`  ${dim('every host reads this file — chrome via config-sync, native hosts directly')}`);
  }
  return 0;
}

async function add(argv) {
  const noVerify = argv.includes('--no-verify');
  const url = argv.find(a => !a.startsWith('-'));
  if (!url) { console.error('opencues calendar add: needs a feed URL'); return 2; }
  if (!isFeedUrl(url)) {
    console.error(`opencues calendar add: not a feed URL (need http(s):// or webcal://): ${url}`);
    return 2;
  }

  const lines = readLines();
  const existing = activeUrls(lines);
  if (existing.includes(url)) { console.log(`${dim('already added:')} ${url}`); return 0; }

  if (!noVerify) {
    process.stdout.write(dim('verifying feed… '));
    const v = await verifyFeed(url);
    if (v.ok === false) {
      console.log(red('failed') + dim(` — ${v.reason}`));
      console.log(dim('add anyway with --no-verify'));
      return 1;
    }
    if (v.ok === null) console.log(yellow('skipped') + dim(` — ${v.reason}`));
    else {
      const nextStr = v.next ? ` · next: ${v.next.title}${v.next.start ? dim(' ' + v.next.start) : ''}` : '';
      console.log(green('ok') + dim(` — ${v.total} event(s), ${v.upcoming} in the next 60 days${nextStr}`));
    }
  }

  const base = lines === null ? HEADER : (fs.readFileSync(FEEDS_PATH, 'utf8').replace(/\n*$/, '\n'));
  fs.mkdirSync(CUES_DIR, { recursive: true });
  fs.writeFileSync(FEEDS_PATH, base + url + '\n');
  console.log(`${green(G.ringOn)} added ${bold(url)}  ${dim('→ ' + tilde(FEEDS_PATH))}`);
  if (!calendarContextModeOn()) {
    console.log(`  ${yellow('note')} ${dim('calendar-context-mode is off — set')} ${bold('calendar-context-mode: on')} ${dim('in OPENCUES.md to use it')}`);
  }
  console.log(`  ${dim('picked up on the next poll — or')} ${bold('opencues calendar refresh')} ${dim('to load it now')}`);
  console.log(`  ${dim('(first feed + a host already running? restart it once to start the poller)')}`);
  return 0;
}

async function list(argv) {
  const json = argv.includes('--json');
  const withCounts = !argv.includes('--no-fetch') && !json ? true : argv.includes('--fetch');
  const lines = readLines();
  const urls = activeUrls(lines);

  if (json) {
    const out = { path: FEEDS_PATH, present: lines !== null, calendarContextMode: calendarContextModeOn() ? 'on' : 'off', feeds: urls };
    if (withCounts) {
      out.feeds = [];
      for (const u of urls) { const v = await verifyFeed(u); out.feeds.push({ url: u, ...v }); }
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  console.log(banner({ version: cliVersion(), tagline: 'calendar feeds' }));
  console.log('');
  const modeOn = calendarContextModeOn();
  console.log(bold('calendar-context') + '  ' + (modeOn ? green('on') : dim('off')) + (modeOn ? '' : dim('  · set calendar-context-mode: on in OPENCUES.md')));
  console.log(bold('feeds') + dim('  · ' + fileLink(tilde(FEEDS_PATH), FEEDS_PATH)));
  if (urls.length === 0) {
    console.log(`  ${dim('none — add one with')} ${bold('opencues calendar add <url>')}`);
    return 0;
  }
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    let ring = dim(G.ringOn), note = '';
    if (withCounts) {
      const v = await verifyFeed(u);
      if (v.ok === true) { ring = green(G.ringOn); note = dim(`  ${v.total} event(s), ${v.upcoming} upcoming`); }
      else if (v.ok === false) { ring = red(G.ringOn); note = dim(`  ${v.reason}`); }
      else { ring = yellow(G.ringOn); note = dim(`  ${v.reason}`); }
    }
    console.log(`  ${ring} ${dim(String(i + 1) + '.')} ${u}${note}`);
  }
  return 0;
}

function remove(argv) {
  const target = argv.find(a => !a.startsWith('-'));
  if (!target) { console.error('opencues calendar remove: needs a URL or index'); return 2; }
  const lines = readLines();
  if (lines === null) { console.error('opencues calendar remove: no feeds file'); return 1; }
  const urls = activeUrls(lines);
  const asIdx = /^\d+$/.test(target) ? parseInt(target, 10) : null;
  const urlToRemove = asIdx !== null ? urls[asIdx - 1] : target;
  if (!urlToRemove || !urls.includes(urlToRemove)) {
    console.error(`opencues calendar remove: not found: ${target}`);
    return 1;
  }
  const kept = lines.filter(l => l.trim() !== urlToRemove);
  fs.writeFileSync(FEEDS_PATH, kept.join('\n').replace(/\n*$/, '\n'));
  console.log(`${green(G.ringOn)} removed ${bold(urlToRemove)}`);
  console.log(`  ${dim('applied on the next poll — or')} ${bold('opencues calendar refresh')} ${dim('now')}`);
  return 0;
}

function refresh() {
  const urls = activeUrls(readLines());
  if (urls.length === 0) {
    console.log(`${dim('no feeds to refresh — add one with')} ${bold('opencues calendar add <url>')}`);
    return 0;
  }
  const trigger = path.join(CUES_DIR, '.calendar-refresh');
  try {
    fs.mkdirSync(CUES_DIR, { recursive: true });
    fs.writeFileSync(trigger, String(Date.now()) + '\n');
  } catch (e) {
    console.error(`opencues calendar refresh: ${(e && e.message) || e}`);
    return 1;
  }
  console.log(`${green(G.ringOn)} refresh requested`);
  console.log(`  ${dim('a running host will re-poll within ~20s (cache-busted).')}`);
  console.log(`  ${dim('if no host is running, start one — the feed loads on boot.')}`);
  return 0;
}

function usage() {
  console.log('opencues calendar — manage calendar-context calendar feeds (.ics / webcal).');
  console.log('');
  console.log('USAGE');
  console.log('  opencues calendar add <url>          add a feed (verifies it fetches + parses)');
  console.log('  opencues calendar add <url> --no-verify   add without the network check');
  console.log('  opencues calendar list               list feeds + live event counts');
  console.log('  opencues calendar list --json        JSON (scriptable)');
  console.log('  opencues calendar remove <url|N>     remove a feed by URL or 1-based index');
  console.log('  opencues calendar sync               fetch feeds → ~/.cues/calendar.json (every host reads it)');
  console.log('  opencues calendar refresh            force a fresh (cache-busting) poll now');
  console.log('  opencues calendar --help             this help');
  console.log('');
  console.log('Feeds: Luma, Google, Outlook, Apple, or any .ics/webcal URL.');
  console.log('  Luma: Account → Account Syncing → Calendar Syncing → Copy URL.');
}

module.exports = function calendar(argv, _ctx) {
  migrateLegacyPaths();
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { usage(); return 0; }
  if (sub === 'add') return add(argv.slice(1));
  if (sub === 'list' || sub === 'ls') return list(argv.slice(1));
  if (sub === 'remove' || sub === 'rm') return remove(argv.slice(1));
  if (sub === 'sync') return sync(argv.includes('--silent'));
  if (sub === 'refresh') return refresh();
  console.error(`opencues calendar: unknown subcommand '${sub}'`);
  usage();
  return 2;
};
