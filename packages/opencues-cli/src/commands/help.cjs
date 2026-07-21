// `opencues help [<command>]` — discoverable help.
//
// Without args: print the top-level overview + command list.
// With a command name: defer to that command's --help (each subcommand
// implements its own).

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { bold, dim, banner, green, accent, tree, G } = require('../lib/style.cjs');

// Render a command row: bold name (padded to 24 cols of visible width)
// + plain description. ANSI codes are zero-width so padEnd before
// stylization keeps the column alignment intact.
function cmd(name, desc, pad = 24) {
  return `  ${bold(name.padEnd(pad))}  ${desc}`;
}
// Render an array of items as a connected tree with continuation rows.
// Each item has `{ label, value, continuations? }`. Branches and stem
// are dim so the structure recedes; the visual emphasis sits on the
// labels (bold) and values.
function configTree(items, valueCol = 28) {
  const out = [];
  const pad = valueCol - 5; // 2 (branch) + 1 (space) + pad + 2 (gap) = valueCol
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const isLast = i === items.length - 1;
    const branch = dim(isLast ? G.treeEnd : G.treeMid);
    out.push(`${branch} ${bold(it.label.padEnd(pad))}  ${it.value}`);
    for (const cont of it.continuations || []) {
      const stem = isLast ? ' ' : dim(G.treeStem.trim());
      out.push(`${stem}${' '.repeat(valueCol - 1)}${cont}`);
    }
  }
  return out.join('\n');
}
// Left-aligned (no indent) variant — used by the Configuration block
// once its heading was dropped. Content lands at col 27 (24-pad + 2 gap).
function cmdL(name, desc, pad = 24) {
  return `${bold(name.padEnd(pad))}  ${desc}`;
}
function head(title) { return bold(title); }

// Lazy-load the provider registry (just llm-provider.js, ~2ms — NOT
// the full core which transitively pulls in resolver/sources). Cached
// across calls. Returns null if core isn't built yet; callers degrade
// gracefully.
let _cachedProviderRegistry = null;
function loadProviderRegistry(ctx) {
  if (_cachedProviderRegistry !== null) return _cachedProviderRegistry;
  try {
    _cachedProviderRegistry = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/llm-provider.js'));
  } catch { _cachedProviderRegistry = false; }
  return _cachedProviderRegistry || null;
}

// Compact snapshot of the user's current setup. Provider data sourced
// from @opencues/core's PROVIDERS registry (single source of truth);
// filesystem reads for everything else. Returns rows for the standard
// cmd() layout — caller wraps in a `Configuration:` section heading.
function configRows(ctx) {
  const HOME = os.homedir();
  const core = loadProviderRegistry(ctx);

  const candidates = [
    { label: '$OPENCUES_HOME', dir: process.env.OPENCUES_HOME },
    { label: './.cues',        dir: path.join(process.cwd(), '.cues') },
    { label: '~/.cues',        dir: path.join(HOME, '.cues') },
  ];
  const active = candidates.filter(c => c.dir && fs.existsSync(c.dir));

  let cues = 0, blanks = 0, auditors = 0;
  for (const a of active) {
    cues     += countConfigs(path.join(a.dir, 'cues'),     'CUE.md');
    blanks   += countConfigs(path.join(a.dir, 'blanks'),   'BLANK.md');
    auditors += countConfigs(path.join(a.dir, 'auditors'), 'AUDITOR.md');
  }

  const pathSummary = active.length
    ? active.map(a => bold(a.label)).join(dim(' + '))
    : dim('(no config — run `opencues seed-configs`)');

  // Runtime scalars (llm-provider, llm-model, debug-mode, …) live in
  // OPENCUES.md frontmatter — canonical filename declared in
  // packages/opencues-core/src/feature-registry.ts as CORE_SETTINGS_FILE.
  // (A pre-2026 design considered merging OPENCUES.md into CUES.md
  // but the migration never landed; that CUES.md fallback was
  // vestigial and has been removed.)
  const settingsFile = path.join(HOME, '.cues', 'OPENCUES.md');

  // Auto-route preference order — sourced from @opencues/core's
  // PROVIDER_AUTO_ORDER. cerebras first (1.8-3× faster than groq on
  // same gpt-oss-120b model), openai last (broken on most pipelines
  // but better than silent no-op). If core isn't loaded, fall back to
  // a frozen snapshot so help still works pre-build.
  const AUTO_ORDER = core
    ? core.PROVIDER_AUTO_ORDER.map(id => ({ id, envKey: core.getProvider(id)?.envKeyName }))
        .filter(p => !!p.envKey)
    : [
        { id: 'cerebras', envKey: 'CEREBRAS_API_KEY' },
        { id: 'groq',     envKey: 'GROQ_API_KEY' },
        { id: 'gemini',   envKey: 'GEMINI_API_KEY' },
        { id: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
        { id: 'openai',   envKey: 'OPENAI_API_KEY' },
      ];
  const envFileForRoute = path.join(HOME, '.cues', '.env');
  const envFileContents = fs.existsSync(envFileForRoute) ? fs.readFileSync(envFileForRoute, 'utf8') : '';
  function hasKey(envKey) {
    return !!process.env[envKey] || new RegExp(`^${envKey}=\\S`, 'm').test(envFileContents);
  }
  function autoPickProvider() {
    for (const p of AUTO_ORDER) if (hasKey(p.envKey)) return p.id;
    return null;
  }
  const autoPicked = autoPickProvider();

  const globalProviderSet = readScalar(settingsFile, 'llm-provider');
  const globalProvider = globalProviderSet || autoPicked || 'cerebras';
  const globalModel    = readScalar(settingsFile, 'llm-model');
  // Three-bucket UX (cues / auditors / blanks) — matches the menu, the
  // fluid-config classifier, and docs/architecture/llm-routing.md.
  // Per-aspect scalars (word-cues-provider, fluid-blank-provider,
  // agent-provider, …) still WIN at the resolver, but they're advanced
  // overrides — the primary user-facing surface is the three buckets.
  // Bucket scalar 'inherit' (or unset) falls through to the global
  // llm-provider; concrete provider id pins this bucket.
  const resolveBucket = (bucketScalar) => {
    const raw = (readScalar(settingsFile, bucketScalar) || '').toLowerCase();
    return raw && raw !== 'inherit' ? raw : globalProvider;
  };
  const surfaces = [
    ['cues',     resolveBucket('cues-llm-provider')],
    ['auditors', resolveBucket('auditors-llm-provider')],
    ['blanks',   resolveBucket('blanks-llm-provider')],
  ].map(([s, p]) => {
    const bucketModel = readScalar(settingsFile, `${s}-llm-model`);
    const model =
      bucketModel ||
      globalModel ||
      (core?.getProvider(p.toLowerCase())?.defaultModel) ||
      PROVIDER_DEFAULT_MODEL[p.toLowerCase()] ||
      '';
    return [s, p, model];
  });
  // Keys row layout — set FIRST so the provider slot width can derive
  // from it (providers use 2 slots; their single middle divider should
  // land on the same column as the Keys row's MIDDLE divider).
  const envFile = path.join(HOME, '.cues', '.env');
  const envContents = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  // Keys to show in the env-var grid. LLM keys sourced from the
  // registry; FINNHUB_API_KEY (stocks blank, non-LLM) is the lone
  // hardcoded entry. Split into two rows for layout — 4 + (rest)
  // keeps the grid square. Adding a provider auto-flows into the rows.
  const allKeys = [...new Set([
    ...(core
      ? core.listProviders().map(p => p.envKeyName).filter(Boolean) // some providers (e.g. local) have no env key
      : ['GROQ_API_KEY', 'CEREBRAS_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY']),
    'FINNHUB_API_KEY', // stocks blank (non-LLM) — the lone hardcoded entry
  ])];
  const KEY_WIDTH = Math.max(...allKeys.map(k => k.length));
  const SEP = '  │  ';                          // 5 visible chars (providers row spacing)
  const keyIsSet = k => !!process.env[k] || new RegExp(`^${k}=\\S`, 'm').test(envContents);
  // green ● = key present, gray ● = missing.
  const keyCell = k => `${bold(k.padEnd(KEY_WIDTH))} ${keyIsSet(k) ? green(G.ringOn) : dim(G.ringOn)}`;
  // Adaptive grid: fit as many equal-width, aligned columns as the terminal
  // allows so rows never soft-wrap into a jumble. Content starts at VALUE_COL.
  const VALUE_COL = 28;
  const KEY_GAP = '   ';
  const KEY_CELL_W = KEY_WIDTH + 2;             // key + space + ring glyph
  const keyAvail = (process.stdout.columns || parseInt(process.env.COLUMNS, 10) || 80) - VALUE_COL;
  const KEY_COLS = Math.max(1, Math.floor((keyAvail + KEY_GAP.length) / (KEY_CELL_W + KEY_GAP.length)));
  const keyRows = [];
  for (let i = 0; i < allKeys.length; i += KEY_COLS) {
    keyRows.push(allKeys.slice(i, i + KEY_COLS).map(keyCell).join(KEY_GAP));
  }

  // Three buckets, single row. Size each slot to fit its actual
  // content (label + provider + ' · ' + full model id) — no truncation.
  // The earlier 2-row 4-surface layout fit a 1/2-Keys-row budget; the
  // 3-bucket layout is wider in aggregate but each slot stays compact
  // enough that two inter-slot separators don't push past terminal width.
  const LABEL_W = Math.max(...surfaces.map(s => s[0].length));
  // Find the widest slot's natural width so every slot pads to the
  // same column — keeps the three slots visually aligned.
  const naturalWidths = surfaces.map(([, p, m]) =>
    (LABEL_W + 1) + 1 + displayProvider(p, core).length + 3 + displayModel(m).length,
  );
  const PROVIDER_SLOT_W = Math.max(...naturalWidths);
  const slotForSurface = ([s, p, m]) => {
    const pname = displayProvider(p, core);
    const labelCol = (s + ':').padEnd(LABEL_W + 1);
    const mname = displayModel(m);
    const used = (LABEL_W + 1) + 1 + pname.length + 3 + mname.length;
    const padding = ' '.repeat(Math.max(0, PROVIDER_SLOT_W - used));
    return `${dim(labelCol)} ${bold(pname)} ${dim('·')} ${bold(mname)}${padding}`;
  };
  // Providers: keep the same SEP visible width so the slot grid lines
  // up with the Keys row, but replace the `│` with whitespace.
  const PROVIDER_SEP = ' '.repeat(SEP.length);
  const surfaceRow1 = surfaces.map(slotForSurface).join(PROVIDER_SEP);
  const surfaceRow2 = null; // three buckets fit on one row now

  // Auto-route annotation: when the user has NOT set llm-provider:
  // explicitly, surface that the provider grid above was picked by the
  // auto-router. Helps the user understand why fluid-blank suddenly
  // routes to cerebras when they only set CEREBRAS_API_KEY.
  // Auto-route chain text + "no keys" hint both derived from the
  // same AUTO_ORDER above. Adding a provider to the registry updates
  // both strings automatically.
  const chainText = AUTO_ORDER.map(p => p.id).join(' > ');
  const envKeysList = AUTO_ORDER.map(p => p.envKey).join(' / ');
  const routeNote = globalProviderSet
    ? null
    : autoPicked
      ? dim(`auto-routed (${chainText}); set ${bold('llm-provider:')} in OPENCUES.md to override`)
      : dim(`no keys set — set any of ${envKeysList}`);

  const providerContinuations = [];
  if (surfaceRow2) providerContinuations.push(surfaceRow2);
  if (routeNote) providerContinuations.push(routeNote);

  return [
    { label: 'Paths:',
      value: `${pathSummary}  ${dim(`(${cues} cues, ${blanks} blanks, ${auditors} auditors)`)}` },
    { label: 'Keys:',
      value: keyRows[0],
      continuations: keyRows.slice(1) },
    { label: 'Providers:',
      value: surfaceRow1,
      continuations: providerContinuations },
  ];
}

function countConfigs(dir, primary) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  const primaryLower = primary.toLowerCase();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (fs.existsSync(path.join(dir, e.name, primary))
        || fs.existsSync(path.join(dir, e.name, primaryLower))) {
      n++;
    }
  }
  return n;
}

function readScalar(filePath, key) {
  if (!fs.existsSync(filePath)) return null;
  const txt = fs.readFileSync(filePath, 'utf8');
  const fm = txt.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const m = fm[1].match(new RegExp(`^${key}:\\s*['"]?([^'"\\s]+)`, 'm'));
  return m ? m[1] : null;
}

// Display-case fallback for when the @opencues/core registry isn't
// loadable (pre-build). Live data sourced from getProvider(id).displayName.
function displayProvider(id, core) {
  if (!id) return null;
  const fromRegistry = core?.getProvider(id.toLowerCase())?.displayName;
  if (fromRegistry) return fromRegistry;
  // Fallback for pre-build / unknown id
  return PROVIDER_DISPLAY[id.toLowerCase()] || (id[0].toUpperCase() + id.slice(1));
}
const PROVIDER_DISPLAY = {
  groq: 'Groq', cerebras: 'Cerebras', openai: 'OpenAI',
  anthropic: 'Claude', openrouter: 'OpenRouter', gemini: 'Gemini',
  'claude-code-cli': 'Claude Code (CLI, subscription)',
  'openai-subscription': 'OpenAI (ChatGPT subscription)',
  'opencode-zen': 'OpenCode Zen',
  ollama: 'Ollama (local)',
};

// Default model fallback for pre-build. Live data sourced from
// getProvider(id).defaultModel.
const PROVIDER_DEFAULT_MODEL = {
  groq:       'openai/gpt-oss-120b',
  cerebras:   'gpt-oss-120b',
  openai:     'gpt-5.4-mini',
  anthropic:  'claude-haiku-4-5-20251001',
  openrouter: 'openai/gpt-oss-120b:free',
  gemini:     'gemini-3.1-flash-lite',
  'claude-code-cli': 'haiku',
  'openai-subscription': 'gpt-5.4-mini',
  'opencode-zen': 'big-pickle',
  ollama:     'gemma4:e2b',
};
// Strip cosmetic prefixes/suffixes for display ('openai/foo' → 'foo',
// 'foo:free' → 'foo'). Keeps the meaningful model identity, trims chrome.
function displayModel(m) {
  if (!m) return '';
  return m.replace(/^openai\//, '').replace(/:free$/, '');
}
function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = function help(argv, ctx) {
  if (argv.length > 0) {
    // Forward to subcommand help.
    const sub = argv[0];
    try {
      require(path.join(ctx.PKG_DIR, 'src/commands', `${sub}.cjs`))(['--help'], ctx);
      return;
    } catch (err) {
      console.error(`opencues: unknown command "${sub}"\n`);
    }
  }

  const { pkg } = ctx;
  console.log(banner({ version: pkg.version, tagline: 'Native AI integration anywhere you type. Model agnostic and fully open source. Inline agents and prompting.' }));
  console.log(dim(G.treeStart));   // dim │ — visual link from the C_ badge down into the tree
  console.log(configTree(configRows(ctx)));
  console.log('');
  console.log('');
  console.log(`Usage: opencues ${bold('<command>')} [options]`);
  // Shared label width across every command section so descriptions
  // line up at the same column (col 29 = 2-char branch + 1 space + 23 + 2 gap).
  const LABEL_W = 23;
  // Section helper: title as plain bold text (no `│` prefix), tree rows
  // beneath, then a dim `│` connector that links to the next section.
  // Last section omits the trailing connector.
  const sections = [
    { title: 'Setup', description: 'install integrations, manage configs + API keys', rows: [
      ['install <host>',     'Install a host integration (claude-code|opencode|chrome|gemini-cli|--all)'],
      ['uninstall <host>',   'Roll back an installation'],
      ['seed-configs',       'Copy repo defaults into ~/.cues/ (first-time + sync)'],
      ['update-configs',     'Pull new shipped cues/blanks into ~/.cues/ (after a `git pull`)'],
      ['update',             'Pull, rebuild, redeploy installed integrations'],
      ['set-key <provider>', 'Store an API key in ~/.cues/.env'],
      ['config [get|set]',   'Browse + change OpenCues settings (interactive or scriptable)'],
      ['identity',           'Manage IDENTITY.md personal-data fields (interactive or scriptable)'],
      ['check-keys',         'Verify configured API keys against provider endpoints'],
      ['models',             'Effective LLM routing per bucket + provider/model catalog'],
    ]},
    { title: 'Authoring', description: 'create, validate, and import cues/blanks/packs', rows: [
      ['init',                  'Scaffold <cwd>/.cues/ with templates'],
      ['new <kind> <name>',     'Scaffold a single cue / blank'],
      ['validate',              'Lint configs across search paths'],
      ['review <pack> [--llm]', 'Security review a third-party pack before installing'],
      ['import <source>',       'Download a community config pack (gist/github/url/local)'],
    ]},
    { title: 'Run / inspect', description: 'launch hosts and inspect runtime state', rows: [
      ['run <host>',         'Launch the patched host (claude-code | opencode | chrome | gemini-cli)'],
      ['sync <host>',        "Bundle .cues/ into a host that doesn't auto-discover (chrome)"],
      ['which',              'Print every relevant path (installs, configs, logs)'],
      ['version',            'Print CLI version + per-integration versions/compat'],
      ['doctor',             'Cross-host diagnostics + suggested fixes'],
      ['list',               'List every defined cue / blank with source path'],
      ['show <name>',        'Print full config for one cue / blank by name'],
      ['context [list]',     'Show identity / blank / ambient context (what the LLM would see)'],
      ['calendar add <url>', 'Add/list/remove calendar-context calendar feeds (.ics / webcal: Luma, Google, …)'],
      ['cleanup [--kill]',   'Find or kill orphan host processes from prior `opencues run`'],
      ['edit <file>',        'Open ~/.cues/<file>.md in $EDITOR'],
      ['logs [--tail]',      'Show /tmp/opencues.log (last 50 lines, or follow with --tail)'],
      ['debug [on|off]',     'Toggle runtime debug-mode (~/.cues/OPENCUES.md; no arg = print current)'],
      ['completion <shell>', 'Print shell completion script (bash | zsh | fish)'],
      ['help [<command>]',   "Show help. With <command>: that subcommand's help."],
    ]},
    { title: 'Per-host details', description: 'what each integration patches and how', rows: [
      ['claude-code', 'OpenCues for Claude Code (patches cli.js via tweakcc)'],
      ['opencode',    'OpenCues for OpenCode (patches a TS fork)'],
      ['chrome',      'OpenCues Chrome MV3 extension'],
      ['gemini-cli',  "OpenCues for Gemini CLI 0.41.x (patches the fork's React/Ink TSX)"],
      ['shell',       'OpenCues shell wrapper (tmux slide-pane input box)'],
      ['apple-notes', 'OpenCues for Apple Notes (macOS JXA polling daemon)'],
    ]},
    { title: 'Configs', description: 'where OpenCues looks for cues/blanks (highest priority first)', rows: [
      ['Project-level:', bold('<cwd>/.cues/')],
      ['User-level:',    bold('~/.cues/')],
      ['Override:',      `${bold('$OPENCUES_HOME')} ${dim('(top priority)')}`],
    ]},
    { title: 'Examples', description: 'common command patterns', rows: [
      ['opencues install cc',     dim('# install for Claude Code')],
      ['opencues install --all',  dim('# install all integrations')],
      ['opencues seed-configs',   dim('# populate ~/.cues/')],
      ['opencues config',         dim('# browse + change settings')],
      ['opencues which',          dim('# show "where does X live?"')],
      ['opencues doctor',         dim('# diagnose install issues')],
    ]},
  ];
  for (const s of sections) {
    console.log('');
    console.log(tree({ title: s.title, description: s.description, labelWidth: LABEL_W, rows: s.rows }));
  }
};

// Reusable elaborate status block (Paths + Keys ● grid + Providers) so the
// no-arg launcher shows the same header `help` does. Assumes the banner was
// already printed by the caller.
module.exports.printStatus = function printStatus(ctx) {
  console.log(dim(G.treeStart));
  console.log(configTree(configRows(ctx)));
};
