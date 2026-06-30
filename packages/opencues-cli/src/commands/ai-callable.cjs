// `opencues ai-callable` — manage the USER-owned ai-callable trust list
// (typed-sentinel Phase 4). A blank with `ai-callable: true` is callable by the
// LLM with an on-demand argument ONLY when it is an audited built-in fetch
// class (stocks/weather/crypto, trusted by code identity) OR the user has
// explicitly listed it here. A pack can never self-grant — installing ≠
// enabling. This command is a friendly front-end to the `ai-callable-allow:`
// line in ~/.cues/OPENCUES.md; hand-editing that line works identically.
//
// Usage:
//   opencues ai-callable list                 → audited core + your trusted list + eligible-but-untrusted
//   opencues ai-callable allow <blank>        → trust a blank (shows its impl/network first)
//   opencues ai-callable remove <blank>       → untrust a blank
//
// See: docs/architecture/security-audit.md #23, docs/architecture/typed-sentinel-language.md

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { tag, bold, dim, green, yellow, fileLink, banner, cliVersion, G } = require('../lib/style.cjs');
const prompt = require('../lib/prompt.cjs');

const HOME = process.env.OPENCUES_HOME || path.join(os.homedir(), '.cues');
const OPENCUES_PATH = path.join(HOME, 'OPENCUES.md');
const BLANKS_DIR = path.join(HOME, 'blanks');

// Audited built-in classes that are ai-callable by code identity (no trust
// entry needed). Mirrors AUDITED_AI_CALLABLE_CLASSES in boot-common.ts — keep in
// sync if a class is added there after an arg-safety review.
const AUDITED_CORE = ['stocks', 'weather', 'crypto'];

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

/** Parse the comma-separated `ai-callable-allow:` value from OPENCUES.md. */
function readAllow(md) {
  if (!md) return [];
  // Horizontal whitespace only after the colon — a bare `\s*` would cross the
  // newline of an EMPTY value and swallow the `---` frontmatter fence on the
  // next line, reading it as a fake trusted entry (then writeAllow persisted
  // it). The `^-+$` guard drops any stray fence token already on disk.
  // Falls back to the pre-rename allow line so existing configs keep working
  // until the next write migrates them.
  const m = md.match(/^[ \t]*ai-callable-allow[ \t]*:[ \t]*(.*)$/m)
    || md.match(/^[ \t]*param-safe-allow[ \t]*:[ \t]*(.*)$/m); // LEGACY-NAME-ALLOW: pre-rename scalar
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(s => s && !/^-+$/.test(s));
}

/** Upsert `ai-callable-allow: <list>` into the OPENCUES.md frontmatter. */
function writeAllow(list) {
  let md = read(OPENCUES_PATH);
  if (md === null) {
    console.error(`${tag('err')} ${OPENCUES_PATH} not found — run \`opencues seed-configs\` first.`);
    process.exit(1);
  }
  const line = `ai-callable-allow: ${list.join(', ')}`;
  // Migrate a legacy allow line in place if present.
  if (/^\s*param-safe-allow\s*:.*$/m.test(md)) { // LEGACY-NAME-ALLOW: pre-rename scalar
    md = md.replace(/^\s*param-safe-allow\s*:.*$/m, line); // LEGACY-NAME-ALLOW: pre-rename scalar
  } else if (/^\s*ai-callable-allow\s*:.*$/m.test(md)) {
    md = md.replace(/^\s*ai-callable-allow\s*:.*$/m, line);
  } else {
    // Insert before the closing frontmatter fence (second `---`).
    const fences = [...md.matchAll(/^---\s*$/gm)];
    if (fences.length >= 2) {
      const at = fences[1].index;
      md = md.slice(0, at) + line + '\n' + md.slice(at);
    } else {
      md = md.replace(/\n?$/, `\n${line}\n`); // no frontmatter — append (degrade)
    }
  }
  fs.writeFileSync(OPENCUES_PATH, md);
}

/** Read a blank's frontmatter fields the user should see before trusting it. */
function blankInfo(name) {
  for (const cand of [path.join(BLANKS_DIR, name, 'BLANK.md'), path.join(BLANKS_DIR, `${name}.md`)]) {
    const md = read(cand);
    if (md == null) continue;
    const fm = (k) => { const m = md.match(new RegExp(`^\\s*${k}\\s*:\\s*(.*)$`, 'm')); return m ? m[1].trim() : null; };
    return {
      path: cand,
      aiCallable: /^\s*ai-callable\s*:\s*true\s*$/m.test(md),
      blankScript: fm('blankScript'),
      impl: fm('impl'),
      network: fm('network'),
      sandbox: fm('sandbox'),
    };
  }
  return null;
}

module.exports = async function aiCallable(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const positional = argv.filter(a => !a.startsWith('-'));
  const [sub, name] = positional;

  // Interactive menu only with no subcommand on a real terminal; every
  // explicit subcommand (and any non-TTY context) stays one-shot + scriptable.
  if (!sub && prompt.isInteractive()) return interactive(ctx);

  console.log(banner({ version: cliVersion(ctx), tagline: 'ai-callable trust list' }));
  console.log('');

  if (sub === 'list' || !sub) return list();
  if (sub === 'allow') return allow(name);
  if (sub === 'remove') return remove(name);
  console.error(`${tag('err')} unknown subcommand "${sub}". Try: list | allow <blank> | remove <blank>`);
  process.exit(1);
};

// Interactive trust manager: a status list you toggle in place. Audited core
// is shown but not toggleable; enabling a custom blank shows its impl/network
// and asks for confirmation (trust with eyes open). Writes the same
// `ai-callable-allow:` line, so hand-editing keeps working.
async function interactive(ctx) {
  for (;;) {
    const md = read(OPENCUES_PATH);
    const allowList = readAllow(md);
    const typed = md && /^\s*sentinel-language\s*:\s*typed\s*$/m.test(md);
    // Toggleable = declared-ai-callable (non-core, non-script) ∪ currently-trusted.
    const declared = listDeclaredAiCallable()
      .filter(n => !AUDITED_CORE.includes(n))
      .filter(n => { const i = blankInfo(n); return !(i && i.blankScript); });
    const toggleable = [...new Set([...declared, ...allowList])].sort();

    // Each row leads with a coloured ring marker — green ● = on (trusted),
    // gray ● = off (untrusted). Same glyph, colour-only: a full/empty pair
    // (●/○) are East-Asian *ambiguous* width and render at different cell
    // widths on some fonts, which shifts every column after them. Audited
    // core is NOT in this list — it can't be toggled, so it shows in an
    // "always on" header above instead of as a dimmed, "(disabled)"-tagged row.
    // Layout mirrors the CLI house style (see style.cjs `tree()` + this
    // command's own `list()`): bold section title + dim description, items at
    // a 2-space gutter. Headers print at col 0; the enquirer list renders the
    // selectable rows, each indented to the same gutter so every line — header
    // item, toggle row, empty-state note, Done — sits in one of two columns
    // regardless of state.
    // The prompt lib owns row chrome: the 2-col selection gutter (white `❯`),
    // the on/off status ● (from `ring`), and turning the label white when the
    // row is selected. The command just supplies plain, columnar text — name,
    // on/off word, and an aligned note column. Headers below use IND so their
    // items line up under the lib's gutter+ring.
    const ON = green(G.ringOn);
    const IND = '  ';
    const nameW = Math.max(4, ...toggleable.map(n => n.length));
    const STATW = 3; // 'off'
    const row = (name, on, note) =>
      `${name.padEnd(nameW)}  ${(on ? 'on' : 'off').padEnd(STATW)}${note ? '  ' + note : ''}`;

    const choices = [];
    for (const n of toggleable) {
      const on = allowList.includes(n);
      const info = blankInfo(n);
      const note = info ? '' : yellow('unreachable');
      choices.push({ label: row(n, on, note), ring: on, value: { toggle: n } });
    }
    if (!toggleable.length) {
      choices.push({ label: '(no custom blanks declare ai-callable)', value: null, disabled: true });
    }
    choices.push({ spacer: true });
    choices.push({ label: 'Done', value: { done: true }, dim: true });

    if (process.stdout.isTTY) console.clear();
    console.log(banner({ version: cliVersion(ctx), tagline: 'ai-callable trust list' }));
    console.log('');
    if (!typed) console.log(`${IND}${dim('sentinel-language is not `typed` — the on-demand path is inert until you set it.')}\n`);

    console.log(bold('Built-in') + '  ' + dim('· always on · trusted by code'));
    console.log(IND + AUDITED_CORE.map(n => `${ON} ${n}`).join('   '));
    console.log('');
    console.log(bold('Third-party') + '  ' + dim('· ↑↓ move · Enter toggle on/off'));

    const pick = await prompt.select('', choices);
    if (!pick || pick.done) break;

    const n = pick.toggle;
    if (allowList.includes(n)) {
      writeAllow(allowList.filter(x => x !== n));
    } else {
      const info = blankInfo(n);
      const fw = 8;
      const field = (k, v) => console.log(`${IND}${dim(k.padEnd(fw))}${v}`);
      console.log('');
      console.log(`${IND}${bold(`Trusting "${n}"`)} ${dim('— it will be called with arguments the LLM chooses')}`);
      field('impl', (info && info.impl) || dim('(built-in class)'));
      field('network', (info && info.network) || dim('(none declared)'));
      field('sandbox', (info && info.sandbox) || dim('(none declared)'));
      console.log('');
      const ok = await prompt.confirm(`Trust "${n}"?`, { default: false });
      if (ok) writeAllow([...allowList, n]);
    }
  }
  if (process.stdout.isTTY) console.clear();
  console.log(banner({ version: cliVersion(ctx), tagline: 'ai-callable trust list' }));
  console.log('');
  list();
}

function list() {
  const md = read(OPENCUES_PATH);
  const allow = readAllow(md);
  const typed = md && /^\s*sentinel-language\s*:\s*typed\s*$/m.test(md);

  console.log(bold('Audited core (always ai-callable — trusted by code):'));
  for (const n of AUDITED_CORE) console.log(`  ${tag('ok')} ${n}`);
  console.log('');

  console.log(bold('You trusted (ai-callable-allow):'));
  if (allow.length === 0) console.log(`  ${dim('(none)')}`);
  for (const n of allow) {
    const info = blankInfo(n);
    const reach = info ? '' : dim('  — no BLANK.md found / not reachable by blankFetch');
    console.log(`  ${tag('ok')} ${n}${reach}`);
  }
  console.log('');

  // Blanks that DECLARE ai-callable but aren't enabled (audited or trusted).
  const declared = listDeclaredAiCallable().filter(n => !AUDITED_CORE.includes(n) && !allow.includes(n));
  if (declared.length) {
    console.log(bold('Declared ai-callable but NOT enabled:'));
    for (const n of declared) {
      console.log(`  ${tag('warn')} ${n}  ${dim(`→ run \`opencues ai-callable allow ${n}\``)}`);
    }
    console.log('');
  }

  if (!typed) console.log(`${tag('info')} ${dim('sentinel-language is not `typed` — the whole on-demand path is inert until you set it.')}`);
  console.log(`${tag('info')} source of truth: ${fileLink(OPENCUES_PATH)} ${dim('(`ai-callable-allow:` line — hand-edit to fix fast)')}`);
}

function listDeclaredAiCallable() {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(BLANKS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const n = e.isDirectory() ? e.name : e.name.replace(/\.md$/, '');
    const info = blankInfo(n);
    if (info && info.aiCallable) out.push(n);
  }
  return out;
}

function allow(name) {
  if (!name) { console.error(`${tag('err')} usage: opencues ai-callable allow <blank>`); process.exit(1); }
  const info = blankInfo(name);
  if (!info) {
    console.error(`${tag('err')} no blank named "${name}" found under ${fileLink(BLANKS_DIR)}.`);
    process.exit(1);
  }
  if (info.blankScript) {
    console.error(`${tag('err')} "${name}" is a script blank (blankScript: ${info.blankScript}). A script blank can NEVER be ai-callable — an LLM-provided argument must not reach a shell. Refused.`);
    process.exit(1);
  }
  // Trust with eyes open — surface what's being granted.
  console.log(bold(`Trusting "${name}" for LLM-arg invocation. It will be called with arguments the LLM chooses.`));
  console.log(`  impl:    ${info.impl || dim('(built-in class)')}`);
  console.log(`  network: ${info.network || dim('(none declared)')}`);
  console.log(`  sandbox: ${info.sandbox || dim('(none declared)')}`);
  if (!info.aiCallable) console.log(`  ${tag('warn')} ${dim('note: this blank does not declare `ai-callable: true` in its BLANK.md — add it for the capability to take effect.')}`);
  console.log('');

  const list = readAllow(read(OPENCUES_PATH));
  if (list.includes(name)) { console.log(`${tag('ok')} "${name}" was already trusted.`); return; }
  list.push(name);
  writeAllow(list);
  console.log(`${tag('ok')} trusted "${name}". ${dim(`(${OPENCUES_PATH})`)}`);
}

function remove(name) {
  if (!name) { console.error(`${tag('err')} usage: opencues ai-callable remove <blank>`); process.exit(1); }
  const list = readAllow(read(OPENCUES_PATH));
  if (!list.includes(name)) { console.log(`${tag('info')} "${name}" was not in the trust list.`); return; }
  writeAllow(list.filter(n => n !== name));
  console.log(`${tag('ok')} untrusted "${name}".`);
}

function printHelp() {
  console.log(`opencues ai-callable — manage the ai-callable trust list

  (no args)            interactive trust manager (on a terminal) — toggle in place
  list                 audited core + your trusted blanks + declared-but-not-enabled
  allow <blank>        trust a blank for LLM-arg invocation (shows impl/network first)
  remove <blank>       untrust a blank

  --no-interactive     force the static list instead of the interactive menu

Source of truth is the \`ai-callable-allow:\` line in ~/.cues/OPENCUES.md —
this command just edits it for you. A pack can't write that file, so trust is
always a deliberate user act. Audited core (stocks/weather/crypto) is always on.`);
}
