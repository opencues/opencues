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
  const surfaces = [
    ['word-cues',       readScalar(settingsFile, 'word-cues-provider')       || globalProvider],
    ['fluid-blank',     readScalar(settingsFile, 'fluid-blank-provider')     || globalProvider],
    ['transform-blank', readScalar(settingsFile, 'transform-blank-provider') || globalProvider],
    ['agent',           readScalar(settingsFile, 'agent-provider')           || globalProvider],
  ].map(([s, p]) => {
    const model =
      readScalar(settingsFile, `${s}-model`) ||
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
  const allLlmEnvKeys = core
    ? core.listProviders().map(p => p.envKeyName)
    : ['GROQ_API_KEY', 'CEREBRAS_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'];
  const KEYS_ROW_A = allLlmEnvKeys.slice(0, 4);
  const KEYS_ROW_B = [...allLlmEnvKeys.slice(4), 'FINNHUB_API_KEY'];
  const KEY_WIDTH = Math.max(...[...KEYS_ROW_A, ...KEYS_ROW_B].map(k => k.length));
  const SEP = '  │  ';                          // 5 visible chars
  const KEYS_SLOT_W = KEY_WIDTH + 1 + 1;        // key + space + tick
  const renderKeys = names => names.map(k => {
    const set = !!process.env[k] || new RegExp(`^${k}=\\S`, 'm').test(envContents);
    return `${bold(k.padEnd(KEY_WIDTH))} ${set ? green(G.check) : dim(G.missing)}`;
  }).join(dim(SEP));

  // Provider slot total width — sum of two Keys slots + one separator
  // so the provider row's single divider lines up with the Keys row's
  // middle divider.
  const PROVIDER_SLOT_W = KEYS_SLOT_W * 2 + SEP.length;
  // Per-COLUMN label padding (not per-row): the longest label sharing
  // a column dictates the label width for both rows in that column.
  // Row 1: surfaces[0] / [1].  Row 2: surfaces[2] / [3].
  const COL_LABEL_W = [
    Math.max(surfaces[0][0].length, surfaces[2][0].length),
    Math.max(surfaces[1][0].length, surfaces[3][0].length),
  ];
  const slotForSurface = ([s, p, m], labelW) => {
    const pname = displayProvider(p, core);
    const labelCol = (s + ':').padEnd(labelW + 1);
    const usedBeforeModel = (labelW + 1) + 1 + pname.length + 3;
    const modelBudget = Math.max(0, PROVIDER_SLOT_W - usedBeforeModel);
    const mname = truncate(displayModel(m), modelBudget).padEnd(modelBudget);
    return `${dim(labelCol)} ${bold(pname)} ${dim('·')} ${bold(mname)}`;
  };
  // Providers: keep the same SEP visible width so the slot grid lines
  // up with the Keys row, but replace the `│` with whitespace.
  const PROVIDER_SEP = ' '.repeat(SEP.length);
  const surfaceRow1 = [
    slotForSurface(surfaces[0], COL_LABEL_W[0]),
    slotForSurface(surfaces[1], COL_LABEL_W[1]),
  ].join(PROVIDER_SEP);
  const surfaceRow2 = [
    slotForSurface(surfaces[2], COL_LABEL_W[0]),
    slotForSurface(surfaces[3], COL_LABEL_W[1]),
  ].join(PROVIDER_SEP);

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

  const providerContinuations = [surfaceRow2];
  if (routeNote) providerContinuations.push(routeNote);

  return [
    { label: 'Paths:',
      value: `${pathSummary}  ${dim(`(${cues} cues, ${blanks} blanks, ${auditors} auditors)`)}` },
    { label: 'Keys:',
      value: renderKeys(KEYS_ROW_A),
      continuations: [renderKeys(KEYS_ROW_B)] },
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
  'claude-cli': 'Claude (CLI, subscription)',
  'openai-subscription': 'OpenAI (ChatGPT subscription)',
  'opencode-zen': 'OpenCode Zen',
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
  'claude-cli': 'haiku',
  'openai-subscription': 'gpt-5.4-mini',
  'opencode-zen': 'big-pickle',
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
  console.log(banner({ version: pkg.version, tagline: 'LLM cues and `_`-gated blanks for any editor.' }));
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
      ['check-keys',         'Verify configured API keys against provider endpoints'],
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
      ['opencues which',          dim('# show "where does X live?"')],
      ['opencues doctor',         dim('# diagnose install issues')],
    ]},
  ];
  for (const s of sections) {
    console.log('');
    console.log(tree({ title: s.title, description: s.description, labelWidth: LABEL_W, rows: s.rows }));
  }
};
