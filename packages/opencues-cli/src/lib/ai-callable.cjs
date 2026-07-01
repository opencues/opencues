// AI-callable trust manager — embedded by `opencues config` (the
// "AI-callable blanks" section). Not a standalone command.
//
// A blank with `ai-callable: true` is callable by the LLM with an on-demand
// argument ONLY when it is an audited built-in fetch class
// (stocks/weather/crypto, trusted by code identity) OR the user has explicitly
// trusted it here. A pack can never self-grant — installing ≠ enabling. Edits
// the `ai-callable-allow:` line in ~/.cues/OPENCUES.md; hand-editing that line
// works identically.
//
// Exports:
//   manage(ctx)     — the interactive trust manager (returns to caller on Back)
//   trustedCount()  — how many custom blanks the user has trusted
//
// See: docs/architecture/security-audit.md #23

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { tag, bold, dim, green, yellow, banner, cliVersion, G } = require('./style.cjs');
const prompt = require('./prompt.cjs');

const HOME = process.env.OPENCUES_HOME || path.join(os.homedir(), '.cues');
const OPENCUES_PATH = path.join(HOME, 'OPENCUES.md');
const BLANKS_DIR = path.join(HOME, 'blanks');

// Audited built-in classes that are ai-callable by code identity (no trust
// entry needed). Mirrors AUDITED_AI_CALLABLE_CLASSES in boot-common.ts — keep
// in sync if a class is added there after an arg-safety review.
const AUDITED_CORE = ['stocks', 'weather', 'crypto'];

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

/** Parse the comma-separated `ai-callable-allow:` value from OPENCUES.md. */
function readAllow(md) {
  if (!md) return [];
  // Horizontal whitespace only after the colon — a bare `\s*` would cross the
  // newline of an EMPTY value and swallow the `---` frontmatter fence on the
  // next line. The `^-+$` guard drops any stray fence token already on disk.
  // Falls back to the pre-rename allow line so existing configs keep working.
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

/** How many custom blanks the user has trusted (for the config section note). */
function trustedCount() {
  return readAllow(read(OPENCUES_PATH)).length;
}

// Interactive trust manager: a status list you toggle in place. Audited core
// is shown but not toggleable; enabling a custom blank shows its impl/network
// and asks for confirmation (trust with eyes open). Writes the same
// `ai-callable-allow:` line, so hand-editing keeps working. Returns to the
// caller (config) when the user picks Back.
async function manage(ctx) {
  for (;;) {
    const md = read(OPENCUES_PATH);
    const allowList = readAllow(md);
    const typed = md && /^\s*sentinel-language\s*:\s*typed\s*$/m.test(md);
    // Toggleable = declared-ai-callable (non-core, non-script) ∪ currently-trusted.
    const declared = listDeclaredAiCallable()
      .filter(n => !AUDITED_CORE.includes(n))
      .filter(n => { const i = blankInfo(n); return !(i && i.blankScript); });
    const toggleable = [...new Set([...declared, ...allowList])].sort();

    // Green ● = on (trusted), gray ● = off. The prompt lib owns the gutter +
    // ring + white-on-focus; the command supplies plain columnar text.
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
    choices.push({ label: 'Back', value: { done: true }, dim: true });

    if (process.stdout.isTTY) console.clear();
    console.log(banner({ version: cliVersion(ctx), tagline: 'ai-callable trust list' }));
    console.log('');
    if (!typed) console.log(`${IND}${dim('sentinel-language is not `typed` — the on-demand path is inert until you set it.')}\n`);

    console.log(bold('Built-in') + '  ' + dim('· always on · trusted by code'));
    console.log(IND + AUDITED_CORE.map(n => `${ON} ${n}`).join('   '));
    console.log('');
    console.log(bold('Third-party') + '  ' + dim('· ↑↓ move · Enter toggle on/off · Back to settings'));

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
}

module.exports = { manage, trustedCount };
