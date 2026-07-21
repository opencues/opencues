// `opencues uninstall <host>` — same shape as install; dispatches to
// per-integration installer with `uninstall` action.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tag, step, bold, dim, banner, cliVersion } = require('../lib/style.cjs');
const prompt = require('../lib/prompt.cjs');
const { pickHost } = require('../lib/pick-host.cjs');

const HOST_ALIASES = {
  'claude-code': 'claude-code',
  'claudecode':  'claude-code',
  'claude':      'claude-code',
  'cc':          'claude-code',
  'opencode':    'opencode',
  'oc':          'opencode',
  'chrome':      'chrome',
  'chrome-host': 'chrome',          // native-messaging host (separate sub-action)
  'gemini-cli':  'gemini-cli',
  'geminicli':   'gemini-cli',
  'gemini':      'gemini-cli',
  'shell':    'shell',
  'term':        'shell',
  'oc-edit':     'shell',
  'apple-notes': 'apple-notes',
  'applenotes':  'apple-notes',
  'notes':       'apple-notes',
  'mac':         'mac',
  'macos':       'mac',
  'ax':          'mac',
};
const HOSTS = ['claude-code', 'opencode', 'chrome', 'gemini-cli', 'shell', 'apple-notes', 'mac'];
const HOST_FOLDERS = ['claude-code', 'opencode', 'chrome', 'gemini-cli', 'shell', 'apple-notes', 'mac'];

module.exports = async function uninstall(argv, ctx) {
  // Symmetric to `opencues install skill / plugin` — dispatch before
  // the help check + host resolver so subcommands don't fall through.
  if (argv[0] === 'skill') return uninstallSkill(argv.slice(1), ctx);
  if (argv[0] === 'plugin') return uninstallPlugin(argv.slice(1), ctx);

  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  let target = null;
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') { target = '--all'; continue; }
    if (!a.startsWith('-') && !target) { target = a; continue; }
    passthrough.push(a);
  }

  if (!target && prompt.isInteractive()) {
    target = await pickHost(HOSTS, { verb: 'Uninstall which host', allowAll: true });
    if (!target) return; // cancelled
  }
  if (!target) {
    console.error(`opencues uninstall: missing <host>. One of: ${HOSTS.join(', ')}, --all`);
    console.error('Run `opencues uninstall --help` for details.\n');
    process.exit(2);
  }

  const folders = target === '--all'
    ? HOST_FOLDERS
    : [HOST_ALIASES[target]];
  if (folders[0] === undefined) {
    console.error(`opencues uninstall: unknown host "${target}". Known: ${HOSTS.join(', ')}, --all`);
    process.exit(2);
  }

  // chrome-host uninstalls a separate sub-action (the native-messaging
  // host), not the extension itself. Dispatch the matching action.
  const action = target === 'chrome-host' ? 'uninstall-host' : 'uninstall';

  console.log(banner({ version: cliVersion(ctx) }));
  console.log('');

  let exitCode = 0;
  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    if (folders.length > 1) {
      console.log('');
      console.log(step(i + 1, folders.length, `uninstalling ${bold('@opencues/' + folder)}`));
      console.log('');
    } else {
      console.log(`${tag('info')} uninstalling ${bold('@opencues/' + folder)}`);
    }
    const installer = path.join(ctx.REPO_ROOT, 'integrations', folder, 'bin', 'install.cjs');
    if (!fs.existsSync(installer)) {
      console.error(`${tag('err')} installer not found for "${folder}" (expected ${installer})`);
      exitCode = 1;
      continue;
    }
    const result = spawnSync('node', [installer, action, ...passthrough], { stdio: 'inherit' });
    const code = result.status ?? 1;
    if (code !== 0) {
      exitCode = code;
      console.log(`${tag('err')} ${folder} ${dim(`(exit ${code})`)}`);
    } else {
      console.log(`${tag('ok')} ${folder}`);
    }
  }
  process.exit(exitCode);
};

function printHelp() {
  console.log('opencues uninstall <host> [options]');
  console.log('');
  console.log('Roll back an installation. Same flags as install (see `opencues install --help`).');
  console.log('Each per-host uninstall is the inverse of its install — see the host\'s installer');
  console.log('docstring for exactly what gets removed.');
  console.log('');
  console.log('Special subcommands:');
  console.log('  skill <name>   Remove a previously-installed skill from both ~/.claude/skills/');
  console.log('                 and ~/.config/opencode/skills/');
  console.log('  plugin <name>  Remove a previously-installed opencode plugin');
  console.log('');
  console.log('Examples:');
  console.log('  opencues uninstall cc');
  console.log('  opencues uninstall cc --target /path/to/cli.js');
  console.log('  opencues uninstall --all --dry-run');
  console.log('  opencues uninstall skill cues');
  console.log('  opencues uninstall plugin cues');
}

// `opencues uninstall skill <name>` — remove from both Claude Code's
// and opencode's skill directories. Also removes the .bak backup
// files created by --force installs.
function uninstallSkill(argv, _ctx) {
  const os = require('node:os');
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('opencues uninstall skill <name>');
    console.log('Removes ~/.claude/skills/<name>/SKILL.md (+ .bak) and');
    console.log('        ~/.config/opencode/skills/<name>/SKILL.md (+ .bak)');
    process.exit(0);
  }
  const name = argv.find(a => !a.startsWith('-'));
  if (!name) {
    console.error('opencues uninstall skill: missing <name>');
    process.exit(2);
  }
  const candidates = [
    path.join(os.homedir(), '.claude', 'skills', name),
    path.join(os.homedir(), '.config', 'opencode', 'skills', name),
  ];
  let removed = 0;
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) {
      console.log(`${tag('skip')} ${dir} (not present)`);
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`${tag('ok')} removed ${dir}`);
    removed++;
  }
  if (removed === 0) {
    console.log(`${dim(`skill "${name}" was not installed at either location`)}`);
  }
  process.exit(0);
}

// `opencues uninstall plugin <name>` — remove the plugin file from
// ~/.config/opencode/plugins/<name>.ts AND unregister it from
// ~/.config/opencode/config.json's `plugin: [...]` array.
function uninstallPlugin(argv, _ctx) {
  const os = require('node:os');
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('opencues uninstall plugin <name>');
    console.log('Removes the plugin file and unregisters it from opencode config.');
    process.exit(0);
  }
  const name = argv.find(a => !a.startsWith('-'));
  if (!name) {
    console.error('opencues uninstall plugin: missing <name>');
    process.exit(2);
  }
  const pluginDir = path.join(os.homedir(), '.config', 'opencode', 'plugins');
  // The plugin's absolute .ts path — the same value install.cjs registers
  // as `file://<target>` in config.json. Used for both the file removal
  // (companions[0]) and the config de-registration below.
  const pluginFile = path.join(pluginDir, `${name}.ts`);
  // Remove the plugin file plus its companions: the .SKILL.md prompt
  // source we copy at install time, plus any .bak backup left by a
  // prior --force install.
  const companions = [
    pluginFile,
    path.join(pluginDir, `${name}.ts.bak`),
    path.join(pluginDir, `${name}.SKILL.md`),
  ];
  for (const f of companions) {
    if (fs.existsSync(f)) {
      fs.rmSync(f);
      console.log(`${tag('ok')} removed ${f}`);
    }
  }

  // De-register from opencode config.
  const cfgPath = path.join(os.homedir(), '.config', 'opencode', 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (Array.isArray(cfg.plugin)) {
        const fileUrl = `file://${pluginFile}`;
        const before = cfg.plugin.length;
        cfg.plugin = cfg.plugin.filter(p => (typeof p === 'string' ? p : p[0]) !== fileUrl);
        if (cfg.plugin.length < before) {
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
          console.log(`${tag('ok')} unregistered from ${cfgPath}`);
        } else {
          console.log(`${tag('skip')} ${cfgPath} (entry not present)`);
        }
      }
    } catch (err) {
      console.log(`${tag('err')} could not parse ${cfgPath}: ${err.message}`);
    }
  }
  process.exit(0);
}
