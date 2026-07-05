// `opencues set-key [<provider>] [<key>]` — store an API key in
// ~/.cues/.env. Avoids the user editing their shell rc.
//
//   opencues set-key                  interactive: pick a provider → paste key (masked)
//   opencues set-key <provider>       interactive key entry for that provider
//   opencues set-key <provider> <key> one-shot (scriptable)

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { tag, bold, dim, green, fileLink, banner, cliVersion, G } = require('../lib/style.cjs');
const prompt = require('../lib/prompt.cjs');

// Fallback provider → env-var snapshot, used only when @opencues/core
// isn't built yet. The live list derives from core's PROVIDERS registry
// (see providerMap) so a new core provider auto-flows into set-key.
const FALLBACK_PROVIDERS = {
  cerebras:     'CEREBRAS_API_KEY',
  groq:         'GROQ_API_KEY',
  gemini:       'GEMINI_API_KEY',
  anthropic:    'ANTHROPIC_API_KEY',
  openai:       'OPENAI_API_KEY',
  openrouter:   'OPENROUTER_API_KEY',
  'opencode-zen': 'OPENCODE_ZEN_API_KEY',
};

// Provider → env-var map, registry-driven per the CLI convention.
// CLI-transport providers (claude-code-cli, openai-subscription) have
// no env key and are excluded. Ordered by PROVIDER_AUTO_ORDER (the
// actual auto-fallback chain) so the picker leads with the provider a
// fresh key unlocks first. Finnhub is the lone non-LLM service key,
// appended last.
function providerMap(ctx) {
  let map;
  try {
    const registry = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/llm-provider.js'));
    const adapters = registry.listProviders().filter((p) => p.envKeyName && p.transport !== 'cli');
    const order = registry.PROVIDER_AUTO_ORDER;
    const rank = (id) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
    adapters.sort((a, b) => rank(a.id) - rank(b.id));
    map = Object.fromEntries(adapters.map((p) => [p.id, p.envKeyName]));
  } catch {
    map = { ...FALLBACK_PROVIDERS };
  }
  map.finnhub = 'FINNHUB_API_KEY';
  return map;
}

// Computed per-call, not at module load — tests (and OPENCUES_HOME users)
// override HOME after the module is required.
const envFilePath = () => path.join(os.homedir(), '.cues', '.env');

function keyIsSet(envName) {
  const ENV_FILE = envFilePath();
  const contents = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  return !!process.env[envName] || new RegExp(`^${envName}=\\S`, 'm').test(contents);
}

// Interactive provider picker. Each row shows the env var + a ring: green ●
// when a value is already stored, gray ● when not.
async function pickProvider(PROVIDERS) {
  const nameW = Math.max(...Object.keys(PROVIDERS).map(p => p.length));
  const choices = Object.entries(PROVIDERS).map(([p, envName]) => ({
    label: `${p.padEnd(nameW)}   ${dim(envName)}`,
    ring: keyIsSet(envName),
    value: p,
  }));
  choices.push({ spacer: true });
  choices.push({ label: 'Cancel', value: null, dim: true });
  console.log(dim('Which provider?  ·  ↑↓ move · Enter select'));
  return prompt.select('', choices);
}

module.exports = async function setKey(argv, ctx) {
  const PROVIDERS = providerMap(ctx);
  if (argv.includes('--help') || argv.includes('-h')) return printHelp(PROVIDERS);
  console.log(banner({ version: cliVersion(ctx), tagline: 'store an API key' }));
  console.log('');

  const positional = argv.filter(a => !a.startsWith('-'));
  let [provider, key] = positional;

  // `opencues set-key openrouter --oauth` (or bare `set-key --oauth`) —
  // one-click PKCE: browser approval on openrouter.ai instead of a
  // dashboard visit + copy-paste. The key lands in ~/.cues/.env exactly
  // like a pasted one. OpenRouter is the only provider with a
  // programmatic key-issuance flow today.
  if (argv.includes('--oauth')) {
    provider = provider || 'openrouter';
    if (provider !== 'openrouter') {
      console.error(`opencues set-key: --oauth is only supported for openrouter (got "${provider}").`);
      process.exit(2);
    }
    const { runOauthFlow } = require('../lib/openrouter-oauth.cjs');
    try {
      const oauthKey = await runOauthFlow({
        onStatus: (line) => console.log(`${tag('info')} ${line}`),
      });
      writeKey(PROVIDERS.openrouter || 'OPENROUTER_API_KEY', oauthKey);
    } catch (err) {
      console.error(`${tag('err')} OpenRouter OAuth failed: ${err.message}`);
      console.error(dim('Fallback: create a key at https://openrouter.ai/keys and run `opencues set-key openrouter <key>`.'));
      process.exit(1);
    }
    return;
  }

  // Interactive provider pick when omitted on a real terminal.
  if (!provider && prompt.isInteractive()) {
    provider = await pickProvider(PROVIDERS);
    if (!provider) return; // cancelled
  }
  // Interactive masked key entry when the provider is known but the key isn't.
  if (provider && PROVIDERS[provider] && !key && prompt.isInteractive()) {
    key = await prompt.secret(`Paste the value for ${bold(PROVIDERS[provider])}`);
    if (!key) { console.log(`${tag('info')} cancelled — nothing stored.`); return; }
  }

  if (!provider || !key) {
    console.error('opencues set-key: usage: opencues set-key <provider> <key>');
    console.error(`Providers: ${Object.keys(PROVIDERS).join(', ')}`);
    process.exit(2);
  }
  const envName = PROVIDERS[provider];
  if (!envName) {
    console.error(`opencues set-key: unknown provider "${provider}". Known: ${Object.keys(PROVIDERS).join(', ')}`);
    process.exit(2);
  }

  writeKey(envName, key);
};

function writeKey(envName, key) {
  const ENV_FILE = envFilePath();
  const envDir = path.dirname(ENV_FILE);
  fs.mkdirSync(envDir, { recursive: true });

  let preExistingMode = null;
  if (fs.existsSync(ENV_FILE)) {
    try { preExistingMode = fs.statSync(ENV_FILE).mode & 0o777; } catch {}
  }

  let lines = [];
  if (fs.existsSync(ENV_FILE)) {
    lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  }
  const newLine = `${envName}=${key}`;
  const idx = lines.findIndex(l => l.startsWith(`${envName}=`));
  if (idx >= 0) lines[idx] = newLine;
  else lines.push(newLine);
  fs.writeFileSync(ENV_FILE, lines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });

  // writeFileSync's mode is only applied on creation. Apply unconditionally
  // so an existing file with looser perms gets tightened.
  try { fs.chmodSync(ENV_FILE, 0o600); } catch {}
  try { fs.chmodSync(envDir, 0o700); } catch {}

  if (preExistingMode !== null && (preExistingMode & 0o077) !== 0) {
    console.log(`${tag('warn')} previous ${fileLink(ENV_FILE, ENV_FILE)} mode was ${preExistingMode.toString(8).padStart(4, '0')} (group/other readable); tightened to 0600.`);
  }

  const nowSet = keyIsSet(envName) ? green(G.ringOn) : dim(G.ringOn);
  console.log(`${tag('ok')} stored ${bold(envName)} ${nowSet} in ${fileLink(ENV_FILE, ENV_FILE)}`);
  console.log('');
  console.log(dim('Native hosts (Claude Code / OpenCode / Gemini CLI / shell) read ~/.cues/.env'));
  console.log(dim('at boot — restart the host (or launch via `opencues run <host>`) to pick it'));
  console.log(dim('up. Chrome receives it live via the native-messaging host. A shell-exported'));
  console.log(dim('env var always wins over the file.'));
}

function printHelp(PROVIDERS) {
  console.log('opencues set-key [<provider>] [<key>]');
  console.log('');
  console.log('Store an API key in ~/.cues/.env (chmod 600). Replaces any existing');
  console.log('value for the same provider. With no arguments on a terminal, opens an');
  console.log('interactive provider picker + masked key entry.');
  console.log('');
  console.log('Native hosts read ~/.cues/.env at boot (shell-exported env vars win);');
  console.log('chrome receives it live via the native-messaging host.');
  console.log('');
  console.log(`Providers: ${Object.keys(PROVIDERS).join(', ')}`);
  console.log('');
  console.log('Examples:');
  console.log('  opencues set-key                 # interactive');
  console.log('  opencues set-key cerebras csk_...');
  console.log('  opencues set-key groq gsk_...');
  console.log('  opencues set-key openrouter --oauth   # one-click: browser approval, no dashboard');
  console.log('  opencues set-key finnhub abc123');
}

// Test-only export — pins the registry-driven provider map (ordering,
// coverage, fallback) without driving the interactive command.
module.exports.providerMap = providerMap;
