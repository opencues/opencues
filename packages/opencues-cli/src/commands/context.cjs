// `opencues context` — unified inspection surface for ALL context sources.
//
// Three sources of context tokens that reach the LLM:
//   1. identity-context  — fields from ~/.cues/IDENTITY.md (was SENTINELS.md)  // LEGACY-NAME-ALLOW: historical narrative
//   2. blank-context     — ambient blank tokens (stocks, weather, …)
//   3. ambient-context   — chrome-only field metadata (label, placeholder)
//
// `opencues context list` shows what's currently active across all three:
// what the LLM would see in the prompt, gated by each source's mode scalar.
//
// Usage:
//   opencues context list              → human-readable summary
//   opencues context list --json       → JSON for scripting
//   opencues context --help            → this help
//
// See:
//   docs/features/identity-context.md
//   docs/features/blank-as-context.md
//   docs/features/ambient-context.md
//   tests/benchmarks/blank-sentinels-matrix/FINDINGS.md

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const HOME = os.homedir();
const CUES_DIR = path.join(HOME, '.cues');
const IDENTITY_PATH = path.join(CUES_DIR, 'IDENTITY.md');
const OPENCUES_PATH = path.join(CUES_DIR, 'OPENCUES.md');
const BLANKS_DIR = path.join(CUES_DIR, 'blanks');

function tryLoadCore() {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'opencues-core', 'dist'),
    path.resolve(__dirname, '..', '..', '..', '..', 'node_modules', '@opencues', 'core', 'dist'),
  ];
  for (const c of candidates) {
    try {
      const identity = require(path.join(c, 'identity-context.js'));
      const blankCtx = require(path.join(c, 'blank-context.js'));
      const cuesMd = require(path.join(c, 'cues-md.js'));
      // Map new export names to the local `identity` namespace the CLI uses.
      identity.parseSentinelsMd = identity.parseIdentityMd;
      return { identity, blankCtx, cuesMd };
    } catch {}
  }
  return null;
}

function readFileOrNull(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// ─── Mode parsing ──────────────────────────────────────────────────────────

function parseOpenCuesScalars(content) {
  const out = { identityContextMode: 'off', blankContextMode: 'off', ambientContextMode: 'off' };
  if (!content) return out;
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return out;
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*?):\s*([^\n#]*)/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim().toLowerCase();
    if (key === 'identity-context-mode') {
      out.identityContextMode = ['off', 'safe', 'raw'].includes(val) ? val : 'off';
    }
    if (key === 'blank-context-mode') {
      out.blankContextMode = ['off', 'safe', 'raw'].includes(val) ? val : 'off';
    }
    if (key === 'ambient-context-mode') {
      out.ambientContextMode = val === 'on' ? 'on' : 'off';
    }
  }
  return out;
}

// ─── Blank discovery ───────────────────────────────────────────────────────

function discoverBlanks(core) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(BLANKS_DIR, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const blankMdPath = path.join(BLANKS_DIR, e.name, 'BLANK.md');
    const content = readFileOrNull(blankMdPath);
    if (!content) continue;
    try {
      const parsed = core.cuesMd.parseSingleCueMd(content, e.name, path.join(BLANKS_DIR, e.name));
      const cfg = parsed.blanks && parsed.blanks[e.name];
      if (cfg) out.push({ name: e.name, config: cfg, path: blankMdPath });
    } catch {}
  }
  return out;
}

// ─── Output formatters ─────────────────────────────────────────────────────

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = s => COLOUR ? `\x1b[2m${s}\x1b[0m` : s;
const bold = s => COLOUR ? `\x1b[1m${s}\x1b[0m` : s;
const green = s => COLOUR ? `\x1b[32m${s}\x1b[0m` : s;
const yellow = s => COLOUR ? `\x1b[33m${s}\x1b[0m` : s;
const red = s => COLOUR ? `\x1b[31m${s}\x1b[0m` : s;

function modeLabel(mode) {
  if (mode === 'safe' || mode === 'on') return green(mode);
  if (mode === 'raw') return yellow(mode + ' ⚠ values reach LLM');
  return dim(mode);
}

function describeIdentityFile() {
  const identityContent = readFileOrNull(IDENTITY_PATH);
  return { content: identityContent, path: IDENTITY_PATH };
}

function list(argv, _ctx) {
  const json = argv.includes('--json');
  const core = tryLoadCore();
  if (!core) {
    console.error('opencues context: @opencues/core not loadable (run `pnpm install` and `pnpm build`)');
    return 1;
  }

  const openCuesContent = readFileOrNull(OPENCUES_PATH);
  const modes = parseOpenCuesScalars(openCuesContent);

  const idFile = describeIdentityFile();
  const identity = core.identity.parseSentinelsMd(idFile.content);
  const blanks = discoverBlanks(core);

  // Plan blank-context slots for every blank with as-context set.
  const blankRows = [];
  for (const b of blanks) {
    if (!b.config.asContext || b.config.asContext === 'off') continue;
    const plan = core.blankCtx.planBlankContextSlots(b.config, identity);
    blankRows.push({
      name: b.name,
      mode: b.config.asContext,
      ttl: b.config.contextTtl ?? 60,
      bind: b.config.contextBind ?? null,
      split: b.config.contextBindSplit ?? null,
      slots: plan.slots.map(s => ({ slot: s.slot, token: s.token, description: s.description })),
      warnings: plan.warnings,
    });
  }

  if (json) {
    process.stdout.write(JSON.stringify({
      modes,
      identityFile: { path: idFile.path, present: idFile.content !== null },
      identityFields: identity.fields.map(f => ({ key: f.key, token: f.token, description: f.description })),
      blanks: blankRows,
    }, null, 2) + '\n');
    return 0;
  }

  // Human-readable layout.
  console.log(bold('opencues context — current state'));
  console.log('');
  console.log(`  identity-context-mode  ${modeLabel(modes.identityContextMode)}`);
  console.log(`  blank-context-mode     ${modeLabel(modes.blankContextMode)}`);
  console.log(`  ambient-context-mode   ${modeLabel(modes.ambientContextMode)}  ${dim('(chrome only)')}`);
  console.log('');

  // ─── Identity context ───────────────────────────────────────
  console.log(bold('IDENTITY CONTEXT'));
  if (idFile.content === null) {
    console.log(`  ${dim('no file at')} ${idFile.path}`);
    console.log(`  ${dim('run')} opencues identity ${dim('to create one')}`);
  } else {
    console.log(`  ${dim('file:')} ${idFile.path}`);
    console.log(`  ${dim('fields:')} ${identity.fields.length}`);
    if (identity.fields.length > 0) {
      for (const f of identity.fields) {
        const valHint = modes.identityContextMode === 'raw'
          ? `  ${dim('= ' + JSON.stringify(f.value))}`
          : '';
        console.log(`    ${f.token}${valHint}  ${dim('— ' + f.description)}`);
      }
    }
  }
  console.log('');

  // ─── Blank context ──────────────────────────────────────────
  console.log(bold('BLANK CONTEXT'));
  if (modes.blankContextMode === 'off') {
    console.log(`  ${dim('disabled — set blank-context-mode: safe in OPENCUES.md')}`);
  }
  if (blankRows.length === 0) {
    console.log(`  ${dim('no blanks opted in via as-context: safe')}`);
    console.log(`  ${dim('add `as-context: safe` to a blank\'s BLANK.md frontmatter')}`);
  } else {
    for (const b of blankRows) {
      const bindInfo = b.bind
        ? `bind=${b.bind}${b.split ? ` split="${b.split}"` : ''}`
        : `slots=${JSON.stringify(b.slots.map(s => s.slot))}`;
      console.log(`  ${bold(b.name)}  ${dim(`(${b.mode}, ttl ${b.ttl}s, ${bindInfo})`)}`);
      if (b.slots.length === 0) {
        console.log(`    ${dim('no slots resolved')}`);
      } else {
        for (const s of b.slots) {
          console.log(`    ${s.token}  ${dim('— ' + s.description)}`);
        }
      }
      for (const w of b.warnings) {
        console.log(`    ${red('!')} ${w}`);
      }
    }
  }
  console.log('');

  // ─── Ambient context ────────────────────────────────────────
  console.log(bold('AMBIENT CONTEXT'));
  if (modes.ambientContextMode === 'off') {
    console.log(`  ${dim('disabled — chrome only; set ambient-context-mode: on in OPENCUES.md')}`);
  } else {
    console.log(`  ${green('enabled')}  ${dim('(label + placeholder + page-title for the focused field)')}`);
  }
  console.log('');

  // ─── Summary ────────────────────────────────────────────────
  const totalTokens = identity.fields.length + blankRows.reduce((a, b) => a + b.slots.length, 0);
  const modesActive = [modes.identityContextMode, modes.blankContextMode, modes.ambientContextMode].filter(m => m !== 'off').length;
  console.log(dim(`${totalTokens} token${totalTokens === 1 ? '' : 's'} available · ${modesActive}/3 modes active · provider sees token names${modes.identityContextMode === 'raw' || modes.blankContextMode === 'raw' ? ' + values (raw mode)' : ' only'}`));
  return 0;
}

function usage() {
  console.log('opencues context — inspect all sources of LLM prompt context (identity, blank, ambient).');
  console.log('');
  console.log('USAGE');
  console.log('  opencues context list           show current state of every context source');
  console.log('  opencues context list --json    JSON output (scriptable)');
  console.log('  opencues context --help         this help');
  console.log('');
  console.log('SEE ALSO');
  console.log('  opencues identity               edit IDENTITY.md (the identity-context source)');
  console.log('  opencues doctor                 broader install diagnostics');
}

module.exports = function context(argv, ctx) {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    usage();
    return 0;
  }
  if (sub === 'list' || sub === 'ls') {
    return list(argv.slice(1), ctx);
  }
  console.error(`opencues context: unknown subcommand '${sub}'`);
  usage();
  return 2;
};
