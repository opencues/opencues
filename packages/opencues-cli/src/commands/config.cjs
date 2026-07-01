// `opencues config` — browse + change OpenCues settings (the OPENCUES.md
// scalars). The schema is the FEATURES + MENU_TUNABLES registry in
// @opencues/core (single source of truth), so this command is mostly a
// renderer — adding a feature to the registry makes it appear here for free.
//
// Usage:
//   opencues config                      interactive settings browser (on a TTY)
//   opencues config list                 print every setting + its current value
//   opencues config get <scalar>         print one setting's effective value
//   opencues config set <scalar> <value> change a setting (validated against the registry)
//
// Writes ~/.cues/OPENCUES.md. Hidden footgun values (exposeInMenu:false, e.g.
// identity-context-mode: raw) are NOT offered here — set those by hand-editing
// the file, matching the in-editor cycling menu's protection.

'use strict';

const path = require('node:path');
const os = require('node:os');
const { tag, bold, dim, green, fileLink, banner, cliVersion } = require('../lib/style.cjs');
const prompt = require('../lib/prompt.cjs');
const { readScalars, writeScalar } = require('../lib/opencues-md.cjs');
const aiCallable = require('../lib/ai-callable.cjs');
const fs = require('node:fs');

const HOME = process.env.OPENCUES_HOME || path.join(os.homedir(), '.cues');
const OPENCUES_PATH = path.join(HOME, 'OPENCUES.md');

function loadRegistry(ctx) {
  const tries = [];
  if (ctx && ctx.REPO_ROOT) tries.push(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/feature-registry.js'));
  tries.push('@opencues/core/dist/feature-registry.js');
  for (const t of tries) { try { return require(t); } catch { /* next */ } }
  return null;
}

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

// Display name: drop the `-mode` suffix (the common case) for a tidier column.
const friendly = (scalar) => scalar.replace(/-mode$/, '');

/** Build the section layout against the live registry + current settings. */
function model(ctx) {
  const reg = loadRegistry(ctx);
  if (!reg) return null;
  const settings = readScalars(read(OPENCUES_PATH) || '');
  const defs = reg.getMenuDefinitions(undefined, settings); // Map<scalar,{tip,valueOrder,valueTips}>

  const def = (scalar) => defs.get(scalar);
  const effective = (scalar) => {
    const d = defs.get(scalar); if (!d) return null;
    const cur = settings.get(scalar);
    return (cur != null && cur !== '') ? cur : d.valueOrder[0];
  };
  const isDefault = (scalar) => {
    const d = defs.get(scalar); const cur = settings.get(scalar);
    return !(cur != null && cur !== '' && cur !== d.valueOrder[0]);
  };

  // Sections come from each scalar's registry `group` (single source of
  // truth), ordered by SETTINGS_GROUP_ORDER. Any unlisted group — or an
  // ungrouped scalar ('More') — is appended after, so nothing is ever hidden.
  const order = reg.SETTINGS_GROUP_ORDER || [];
  const byGroup = new Map();
  for (const [scalar, d] of defs) {
    const g = d.group || 'More';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(scalar);
  }
  const sections = [];
  for (const title of order) {
    if (byGroup.has(title)) { sections.push({ title, scalars: byGroup.get(title) }); byGroup.delete(title); }
  }
  for (const [title, scalars] of byGroup) sections.push({ title, scalars });

  return { defs, def, effective, isDefault, sections };
}

module.exports = async function config(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const positional = argv.filter(a => !a.startsWith('-'));
  const [sub, scalar, value] = positional;

  const m = model(ctx);
  if (!m) { console.error(`${tag('err')} failed to load @opencues/core (run \`pnpm build\`).`); process.exit(1); }

  if (!sub && prompt.isInteractive()) return interactive(ctx);

  console.log(banner({ version: cliVersion(ctx), tagline: 'settings' }));
  console.log('');
  if (sub === 'list' || !sub) return list(m);
  if (sub === 'get') return get(m, scalar);
  if (sub === 'set') return set(m, scalar, value);
  console.error(`${tag('err')} unknown subcommand "${sub}". Try: list | get <scalar> | set <scalar> <value>`);
  process.exit(1);
};

// Two-level browser: sections menu → that section's settings → value picker.
// Each screen stays short enough to fit any terminal (no scrolling viewport,
// which enquirer can only do by rotating + wrapping the list).
async function interactive(ctx) {
  for (;;) {
    const m = model(ctx); // re-read each loop so counts reflect prior writes
    const titleW = Math.max(4, ...m.sections.map(s => s.title.length));
    const choices = m.sections.map((sec, i) => {
      const changed = sec.scalars.filter(sc => !m.isDefault(sc)).length;
      const note = changed ? green(`${changed} changed`) : dim('all default');
      return { label: `${sec.title.padEnd(titleW)}   ${note}`, value: { section: i } };
    });
    // AI-callable trust list — another OPENCUES.md setting (`ai-callable-allow:`),
    // but with its own toggle/trust UX, so it opens its dedicated manager.
    const trusted = aiCallable.trustedCount();
    const acNote = trusted ? green(`${trusted} trusted`) : dim('built-in only');
    choices.push({ label: `${'AI-callable blanks'.padEnd(titleW)}   ${acNote}`, value: { aiCallable: true } });
    choices.push({ spacer: true });
    choices.push({ label: 'Done', value: { done: true }, dim: true });

    if (process.stdout.isTTY) console.clear();
    console.log(banner({ version: cliVersion(ctx), tagline: 'settings' }));
    console.log('');
    console.log(dim('Settings  ·  ↑↓ move · Enter open · green = changed from default'));

    const pick = await prompt.select('', choices);
    if (!pick || pick.done) break;
    if (pick.aiCallable) { await aiCallable.manage(ctx); continue; }
    await browseSection(ctx, pick.section);
  }
}

// One section's settings → value picker. Back returns to the sections menu.
async function browseSection(ctx, sectionIdx) {
  for (;;) {
    const m = model(ctx);
    const sec = m.sections[sectionIdx];
    if (!sec) break;
    const nameW = Math.max(4, ...sec.scalars.map(sc => friendly(sc).length));
    const choices = sec.scalars.map(sc => {
      const val = m.effective(sc);
      const shown = m.isDefault(sc) ? dim(val) : green(val);
      return { label: `${friendly(sc).padEnd(nameW)}   ${shown}`, value: { scalar: sc } };
    });
    choices.push({ spacer: true });
    choices.push({ label: 'Back', value: { back: true }, dim: true });

    if (process.stdout.isTTY) console.clear();
    console.log(banner({ version: cliVersion(ctx), tagline: 'settings' }));
    console.log('');
    console.log(bold(sec.title) + '  ' + dim('· ↑↓ move · Enter change · Back to sections'));

    const pick = await prompt.select('', choices);
    if (!pick || pick.back) break;
    await editScalar(ctx, m, pick.scalar);
  }
}

// Submenu: pick one value for a scalar. Current value carries the green ring +
// the initial cursor; each value shows its registry description.
async function editScalar(ctx, m, scalar) {
  const d = m.def(scalar);
  const cur = m.effective(scalar);
  const vw = Math.max(3, ...d.valueOrder.map(v => v.length));
  const vchoices = d.valueOrder.map(v => ({
    label: `${v.padEnd(vw)}   ${dim(d.valueTips.get(v) || '')}`,
    ring: v === cur,
    value: v,
  }));
  vchoices.push({ spacer: true });
  vchoices.push({ label: 'Cancel', value: null, dim: true });

  if (process.stdout.isTTY) console.clear();
  console.log(banner({ version: cliVersion(ctx), tagline: 'settings' }));
  console.log('');
  console.log(bold(friendly(scalar)) + (d.tip ? '  ' + dim('· ' + d.tip) : ''));
  console.log('');

  const chosen = await prompt.select('', vchoices, { initial: Math.max(0, d.valueOrder.indexOf(cur)) });
  if (chosen != null && chosen !== cur) writeScalar(OPENCUES_PATH, scalar, chosen);
}

function list(m) {
  const allScalars = m.sections.flatMap(s => s.scalars);
  const nameW = Math.max(4, ...allScalars.map(sc => friendly(sc).length));
  for (const sec of m.sections) {
    console.log(bold(sec.title));
    for (const sc of sec.scalars) {
      const val = m.effective(sc);
      const shown = m.isDefault(sc) ? `${val} ${dim('(default)')}` : green(val);
      console.log(`  ${friendly(sc).padEnd(nameW)}   ${shown}`);
    }
    console.log('');
  }
  console.log(`${tag('info')} change one: ${dim('opencues config set <scalar> <value>')}  ·  source: ${fileLink(OPENCUES_PATH)}`);
}

function get(m, scalar) {
  if (!scalar) { console.error(`${tag('err')} usage: opencues config get <scalar>`); process.exit(1); }
  if (!m.defs.has(scalar)) { console.error(`${tag('err')} unknown setting "${scalar}".`); process.exit(1); }
  console.log(m.effective(scalar));
}

function set(m, scalar, value) {
  if (!scalar || value === undefined) { console.error(`${tag('err')} usage: opencues config set <scalar> <value>`); process.exit(1); }
  const d = m.defs.get(scalar);
  if (!d) { console.error(`${tag('err')} unknown setting "${scalar}". Run \`opencues config list\`.`); process.exit(1); }
  if (!d.valueOrder.includes(value)) {
    console.error(`${tag('err')} "${value}" is not a valid value for ${scalar}. Choices: ${d.valueOrder.join(', ')}`);
    console.error(`${dim('(footgun values requiring a deliberate file edit are not offered here.)')}`);
    process.exit(1);
  }
  if (!writeScalar(OPENCUES_PATH, scalar, value)) {
    console.error(`${tag('err')} ${OPENCUES_PATH} not found — run \`opencues seed-configs\` first.`);
    process.exit(1);
  }
  console.log(`${tag('ok')} ${scalar} = ${green(value)} ${dim(`(${OPENCUES_PATH})`)}`);
}

function printHelp() {
  console.log(`opencues config — browse + change OpenCues settings

  (no args)                   interactive settings browser (on a terminal)
  list                        every setting + its current value, grouped
  get <scalar>                print one setting's effective value
  set <scalar> <value>        change a setting (validated against the registry)

  --no-interactive            force the static list instead of the browser

Settings live in ~/.cues/OPENCUES.md; this command edits that file. The schema
is the FEATURES + MENU_TUNABLES registry in @opencues/core.`);
}

// Exported for config.test.cjs — the registry-driven section builder.
module.exports.__test__ = { model };
