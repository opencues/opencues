// `opencues install <host>` — dispatch to per-integration installer.
//
// This is a thin shell-out — the actual install logic lives in
// integrations/<host>/bin/install.cjs (which already supports
// install/uninstall/seed-configs/--dry-run/--target/etc.). Cross-cutting
// flags like `--all` are handled here.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tag, step, bold, dim, banner, cliVersion } = require('../lib/style.cjs');

// Host name resolution comes from @opencues/core (HOSTS + HOST_ALIASES +
// resolveHost). 'chrome-host' is the lone special case kept local — it's
// a sub-action of chrome (the native-messaging host install), not a
// distinct host. Caught here and routed in subcommand dispatch.
function loadHostResolver(ctx) {
  try {
    const core = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/host-compat.js'));
    return {
      HOSTS: core.HOSTS.slice().sort(),
      resolve: (name) => name === 'chrome-host' ? 'chrome' : core.resolveHost(name),
    };
  } catch {
    // Pre-build fallback — keep CLI usable.
    return {
      HOSTS: ['chrome', 'claude-code', 'gemini-cli', 'opencode', 'shell'],
      resolve: (name) => {
        const map = {
          'claude-code': 'claude-code', 'claudecode': 'claude-code',
          'claude': 'claude-code', 'cc': 'claude-code',
          'opencode': 'opencode', 'oc': 'opencode',
          'chrome': 'chrome', 'chrome-host': 'chrome',
          'gemini-cli': 'gemini-cli', 'geminicli': 'gemini-cli',
          'gemini': 'gemini-cli',
          'shell': 'shell', 'term': 'shell', 'oc-edit': 'shell',
        };
        return map[name?.toLowerCase?.()] ?? null;
      },
    };
  }
}

module.exports = function install(argv, ctx) {
  // `opencues install skill <name> [--project] [--target <path>] [--force] [--link]`
  // is a separate code path from the host installers — skills aren't a
  // host integration, they're prompt-text files copied into Claude
  // Code's / opencode's skill directories. Dispatched here before the
  // help check + host resolver run (so "skill" doesn't get treated as
  // a host name and `install skill --help` doesn't fall through to the
  // top-level help).
  if (argv[0] === 'skill') {
    return installSkill(argv.slice(1), ctx);
  }

  // `opencues install plugin <name>` — install a host-plugin (currently
  // only opencode supported). Unlike skills (text the chat model
  // consults), plugins are CODE that hooks deterministic events. The
  // cues plugin uses opencode's chat.message hook to write CUES.md on
  // every user message — no model judgment needed.
  if (argv[0] === 'plugin') {
    return installPlugin(argv.slice(1), ctx);
  }

  if (argv.includes('--help') || argv.includes('-h')) return printHelp(ctx);

  const { HOSTS, resolve } = loadHostResolver(ctx);

  // Parse: first non-flag positional is the host. `--all` is a special
  // pseudo-host. Everything else flows through to the per-host installer.
  let target = null;
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') { target = '--all'; continue; }
    if (!a.startsWith('-') && !target) { target = a; continue; }
    passthrough.push(a);
  }

  if (!target) {
    console.error(`opencues install: missing <host>. One of: ${HOSTS.join(', ')}, --all`);
    console.error('Run `opencues install --help` for details.\n');
    process.exit(2);
  }

  // Resolve descriptive name → folder code; --all expands to all folders.
  const folders = target === '--all'
    ? HOSTS.slice()
    : [resolve(target)];
  if (folders[0] === undefined || folders[0] === null) {
    console.error(`opencues install: unknown host "${target}". Known: ${HOSTS.join(', ')}, --all`);
    process.exit(2);
  }

  // The chrome-host installer is a separate sub-action — it installs
  // the local native-messaging host that pushes ~/.cues/ into the
  // running extension. It does NOT need seed-configs (no writes to
  // ~/.cues/) and shares no install steps with the extension itself.
  const isChromeHost = target === 'chrome-host';
  const action = isChromeHost ? 'install-host' : 'install';

  // Preflight: surface platform-specific gotchas BEFORE the install runs
  // so the user isn't surprised by them after the install reports success.
  // Today this is macOS-only — see preflightChecks for the rationale.
  preflightChecks(folders);

  // Run seed-configs FIRST so the user-level ~/.cues/ tree is current
  // before any host installer runs. seed-configs handles all shared writes:
  // first-time copy, library-script sync, OPENCUES.md self-heal, .cs compile.
  // Per-host installers then do strictly host-specific work (patches, etc.).
  // --dry-run flows through; --silent keeps the output focused on host steps.
  if (!isChromeHost && !passthrough.includes('--dry-run')) {
    const seedConfigs = require('./seed-configs.cjs');
    seedConfigs(['--silent'], ctx);
  }

  console.log(banner({ version: cliVersion(ctx) }));
  console.log('');

  let exitCode = 0;
  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    if (folders.length > 1) {
      console.log('');
      console.log(step(i + 1, folders.length, `installing ${bold('@opencues/' + folder)}`));
      console.log('');
    } else {
      console.log(`${tag('info')} installing ${bold('@opencues/' + folder)}`);
    }
    const code = runHostInstaller(folder, action, passthrough, ctx);
    if (code !== 0) {
      exitCode = code;
      console.log(`${tag('err')} ${folder} ${dim(`(exit ${code})`)}`);
    } else {
      console.log(`${tag('ok')} ${folder}`);
    }
  }
  process.exit(exitCode);
};

// Platform preflight — warns about runtime gotchas that the install
// itself won't fail on but the user WILL hit the first time they use
// the affected feature. Today macOS-only, because the two install-time
// blockers a friend hit (sed -i BSD/GNU + pnpm workspace dup) are
// fixed but the runtime path still has bash-4-only and /proc-only
// patches that would silently degrade voice-mode / oc-popup / CC
// statusline on a Mac. Warning here keeps the discovery path: "tried
// to install" → "told about gotchas up front" instead of "install
// looked fine" → "feature mysteriously broken weeks later".
function preflightChecks(folders) {
  const os = require('node:os');
  if (os.platform() !== 'darwin') return;

  const { execSync } = require('node:child_process');
  const warnings = [];

  // bash 4+ — voice-mode (defaults/scripts/speak.sh used to need it;
  // now portable) and oc-popup (mapfile, now portable) and the shell
  // helpers (resolve_link uses POSIX-only constructs). Still warn:
  // user-installed shell snippets, future scripts, and any third-party
  // blank script the user writes will likely assume bash 4 too.
  try {
    const out = execSync('/bin/bash --version 2>/dev/null', { encoding: 'utf8' });
    const m = out.match(/version (\d+)\./);
    const major = m ? parseInt(m[1], 10) : 0;
    if (major > 0 && major < 4) {
      warnings.push({
        item: `/bin/bash is ${major}.x`,
        impact: 'voice-mode, oc-popup, and custom user-blank scripts that use bash 4+ features (mapfile, declare -A, ${var^^}) will fail',
        fix: 'brew install bash  (then optionally `sudo sh -c "echo /opt/homebrew/bin/bash >> /etc/shells; chsh -s /opt/homebrew/bin/bash"`)',
      });
    }
  } catch { /* /bin/bash unavailable — unlikely on macOS; silent skip */ }

  // tmux 3.2+ — only matters if installing the shell integration.
  // `oc-shell` already checks at launch but warning up front saves
  // the user a `brew install tmux` after the install reports success.
  if (folders.includes('shell')) {
    try {
      const out = execSync('tmux -V 2>/dev/null', { encoding: 'utf8' });
      const m = out.match(/tmux (\d+)\.(\d+)/);
      if (m) {
        const maj = parseInt(m[1], 10), min = parseInt(m[2], 10);
        if (maj < 3 || (maj === 3 && min < 2)) {
          warnings.push({
            item: `tmux ${maj}.${min}`,
            impact: 'oc-shell needs tmux 3.2+ for display-popup',
            fix: 'brew install tmux',
          });
        }
      } else {
        warnings.push({
          item: 'tmux not found on PATH',
          impact: 'oc-shell needs tmux 3.2+',
          fix: 'brew install tmux',
        });
      }
    } catch {
      warnings.push({
        item: 'tmux not found on PATH',
        impact: 'oc-shell needs tmux 3.2+',
        fix: 'brew install tmux',
      });
    }
  }

  // bun — needed by shell (oc-edit, oc-editd) and opencode.
  if (folders.includes('shell') || folders.includes('opencode')) {
    try {
      execSync('bun --version 2>/dev/null', { encoding: 'utf8' });
    } catch {
      warnings.push({
        item: 'bun not found on PATH',
        impact: `${folders.includes('shell') ? 'oc-edit / oc-editd' : 'opencode'} won't launch`,
        fix: 'curl -fsSL https://bun.sh/install | bash',
      });
    }
  }

  if (warnings.length === 0) return;

  console.log('');
  console.log(`${tag('info')} macOS preflight — runtime notes for this install:`);
  for (const w of warnings) {
    console.log(`  ${bold('•')} ${w.item}`);
    console.log(`    ${dim('impact:')} ${w.impact}`);
    console.log(`    ${dim('fix:')}    ${w.fix}`);
  }
  console.log(`  ${dim('(install will continue — these affect runtime features, not the install itself)')}`);
  console.log('');
}

function runHostInstaller(host, action, extraArgs, ctx) {
  const installer = path.join(ctx.REPO_ROOT, 'integrations', host, 'bin', 'install.cjs');
  if (!fs.existsSync(installer)) {
    console.error(`opencues install: installer not found for "${host}" (expected ${installer})`);
    return 1;
  }
  const result = spawnSync('node', [installer, action, ...extraArgs], { stdio: 'inherit' });
  return result.status ?? 1;
}

// `opencues install skill <name> [--project] [--target <path>] [--force] [--link]`
//
// Sources: defaults/skills/<name>/SKILL.md (canonical shipped version,
// promoted from tests/agentic/skills/ via scripts/release-skill.sh).
//
// Targets: writes to BOTH Claude Code's and opencode's skill directories
// when the parent install of either tool is detectable (so users with
// both tools get the skill in both; users with only one get it once).
//   Global (default): ~/.claude/skills/<name>/SKILL.md  +
//                     ~/.config/opencode/skills/<name>/SKILL.md
//   --project       : <cwd>/.claude/skills/<name>/SKILL.md +
//                     <cwd>/.config/opencode/skills/<name>/SKILL.md
//   --target <path> : explicit single-file override
//
// Won't overwrite an existing SKILL.md unless --force (avoids silently
// clobbering local tweaks).  --link symlinks instead of copying (for
// power users iterating on the skill from a repo clone).
function installSkill(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printSkillHelp();
  const os = require('node:os');

  let name = null;
  let mode = 'global'; // 'global' | 'project' | 'target'
  let explicitTarget = null;
  let force = false;
  let useLink = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') { mode = 'project'; continue; }
    if (a === '--global') { mode = 'global'; continue; }
    if (a === '--target') { mode = 'target'; explicitTarget = argv[++i]; continue; }
    if (a === '--force') { force = true; continue; }
    if (a === '--link') { useLink = true; continue; }
    if (!a.startsWith('-') && !name) { name = a; continue; }
    console.error(`opencues install skill: unknown arg "${a}"`);
    process.exit(2);
  }

  if (!name) {
    console.error('opencues install skill: missing <name>. Currently shipped: cues');
    console.error('Run `opencues install skill --help` for details.');
    process.exit(2);
  }

  const src = path.join(ctx.REPO_ROOT, 'defaults', 'skills', name, 'SKILL.md');
  if (!fs.existsSync(src)) {
    console.error(`opencues install skill: no such skill "${name}" (expected ${src})`);
    process.exit(2);
  }

  // Build the target list.
  let targets;
  if (mode === 'target') {
    targets = [{ path: explicitTarget, host: 'explicit' }];
  } else {
    const base = mode === 'project' ? process.cwd() : os.homedir();
    // Claude Code skills always go under .claude/skills/<name>/SKILL.md.
    const ccTarget = path.join(base, '.claude', 'skills', name, 'SKILL.md');
    // opencode skills go under .config/opencode/skills/<name>/SKILL.md
    // ONLY if the user has opencode installed (detected by the parent
    // directory existing). Without that, writing into a freshly-created
    // ~/.config/opencode/ would be confusing for users who don't run opencode.
    const ocBase = mode === 'project' ? path.join(base, '.config', 'opencode') : path.join(base, '.config', 'opencode');
    const ocTarget = path.join(ocBase, 'skills', name, 'SKILL.md');
    const ocExists = fs.existsSync(ocBase);
    targets = [{ path: ccTarget, host: 'claude-code' }];
    if (ocExists) targets.push({ path: ocTarget, host: 'opencode' });
  }

  let exitCode = 0;
  for (const t of targets) {
    fs.mkdirSync(path.dirname(t.path), { recursive: true });

    // Refuse to clobber an existing file unless --force.
    if (fs.existsSync(t.path) && !force) {
      const isSymlink = fs.lstatSync(t.path).isSymbolicLink();
      if (isSymlink && useLink) {
        // Re-pointing a symlink at the same source is fine — silently update.
        fs.unlinkSync(t.path);
      } else {
        console.log(`${tag('skip')} ${t.host}: ${t.path} already exists (use --force to overwrite)`);
        continue;
      }
    } else if (fs.existsSync(t.path) && force) {
      // Back up before overwriting.
      const backup = t.path + '.bak';
      fs.copyFileSync(t.path, backup);
      console.log(`${dim('backup → ' + backup)}`);
      fs.unlinkSync(t.path);
    }

    try {
      if (useLink) {
        fs.symlinkSync(src, t.path);
        console.log(`${tag('ok')} ${t.host}: linked ${t.path} → ${src}`);
      } else {
        fs.copyFileSync(src, t.path);
        console.log(`${tag('ok')} ${t.host}: ${t.path}`);
      }
    } catch (e) {
      console.error(`${tag('err')} ${t.host}: ${e.message}`);
      exitCode = 1;
    }
  }

  if (exitCode === 0 && targets.length > 0) {
    console.log('');
    console.log(`${dim('Restart Claude Code / opencode to pick up the skill.')}`);
  }
  process.exit(exitCode);
}

function printSkillHelp() {
  console.log('opencues install skill <name> [options]');
  console.log('');
  console.log('Install an OpenCues-shipped Claude skill into the host\'s skill directory.');
  console.log('Skills are prompt-text files that Claude Code / opencode auto-load on start.');
  console.log('');
  console.log('Currently shipped:');
  console.log('  cues          Ambient skill that writes .cues/CUES.md predicting next-turn vocabulary');
  console.log('');
  console.log('Locations:');
  console.log('  default (--global): ~/.claude/skills/<name>/SKILL.md');
  console.log('                      + ~/.config/opencode/skills/<name>/SKILL.md  (if opencode detected)');
  console.log('  --project         : <cwd>/.claude/skills/<name>/SKILL.md');
  console.log('                      + <cwd>/.config/opencode/skills/<name>/SKILL.md  (if opencode detected)');
  console.log('  --target <path>   : explicit single-file path');
  console.log('');
  console.log('Other flags:');
  console.log('  --force           Overwrite an existing SKILL.md (backs up to .bak first)');
  console.log('  --link            Symlink instead of copy (for dev iteration from a clone)');
  console.log('');
  console.log('Examples:');
  console.log('  opencues install skill cues');
  console.log('  opencues install skill cues --project');
  console.log('  opencues install skill cues --force        # overwrite local tweaks');
}

// `opencues install plugin <name> [--target <path>] [--force]`
//
// Installs an OpenCues-shipped opencode plugin (TypeScript code that
// hooks an event in the opencode plugin system). Currently only the
// `cues` plugin ships — it hooks `chat.message` and writes
// .cues/CUES.md on every user submit (deterministic; doesn't depend on
// the chat model deciding to invoke a skill).
//
// Source: integrations/opencode/plugin/<name>.ts
// Default target: ~/.config/opencode/plugins/<name>.ts +
//   adds a "file://<absolute-path>" entry to ~/.config/opencode/config.json
//   under the `plugin: [...]` array.
function installPlugin(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printPluginHelp();
  const os = require('node:os');

  let name = null;
  let explicitTarget = null;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') { explicitTarget = argv[++i]; continue; }
    if (a === '--force') { force = true; continue; }
    if (!a.startsWith('-') && !name) { name = a; continue; }
    console.error(`opencues install plugin: unknown arg "${a}"`);
    process.exit(2);
  }

  if (!name) {
    console.error('opencues install plugin: missing <name>. Currently shipped: cues');
    process.exit(2);
  }

  const src = path.join(ctx.REPO_ROOT, 'integrations', 'opencode', 'plugin', `${name}.ts`);
  if (!fs.existsSync(src)) {
    console.error(`opencues install plugin: no such plugin "${name}" (expected ${src})`);
    process.exit(2);
  }

  const target = explicitTarget || path.join(os.homedir(), '.config', 'opencode', 'plugins', `${name}.ts`);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (fs.existsSync(target) && !force) {
    console.log(`${tag('skip')} ${target} already exists (use --force to overwrite)`);
  } else {
    if (fs.existsSync(target) && force) {
      const backup = target + '.bak';
      fs.copyFileSync(target, backup);
      console.log(`${dim('backup → ' + backup)}`);
    }
    fs.copyFileSync(src, target);
    console.log(`${tag('ok')} plugin file: ${target}`);
  }

  // Copy the prompt source alongside the plugin file. The cues plugin
  // (and any future plugin shipping a prompt) reads from <plugin-dir>/
  // <name>.SKILL.md. This makes the plugin self-contained — removing
  // the standalone skill via `opencues uninstall skill cues` doesn't
  // break the plugin's prompt source.
  const promptSrc = path.join(ctx.REPO_ROOT, 'defaults', 'skills', name, 'SKILL.md');
  if (fs.existsSync(promptSrc)) {
    const promptTarget = path.join(path.dirname(target), `${name}.SKILL.md`);
    fs.copyFileSync(promptSrc, promptTarget);
    console.log(`${tag('ok')} prompt source: ${promptTarget}`);
  }

  // Register the plugin in opencode's config.json so it loads on next launch.
  const cfgPath = path.join(os.homedir(), '.config', 'opencode', 'config.json');
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { cfg = {}; }
  }
  if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
  const fileUrl = `file://${target}`;
  const already = cfg.plugin.some(p => (typeof p === 'string' ? p : p[0]) === fileUrl);
  if (already) {
    console.log(`${tag('skip')} plugin already registered in ${cfgPath}`);
  } else {
    cfg.plugin.push(fileUrl);
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`${tag('ok')} registered in ${cfgPath}`);
  }

  console.log('');
  console.log(`${dim('Restart opencode to load the plugin.')}`);
  console.log(`${dim('Plugin fires on chat.message → writes <cwd>/.cues/CUES.md every turn.')}`);
  process.exit(0);
}

function printPluginHelp() {
  console.log('opencues install plugin <name> [options]');
  console.log('');
  console.log('Install an opencode plugin shipped with OpenCues.');
  console.log('Plugins hook opencode events (e.g. chat.message) deterministically — no LLM judgment.');
  console.log('');
  console.log('Currently shipped:');
  console.log('  cues          On chat.message: writes <cwd>/.cues/CUES.md using the cues prompt');
  console.log('');
  console.log('Default target: ~/.config/opencode/plugins/<name>.ts');
  console.log('Also registers the plugin in ~/.config/opencode/config.json under `plugin: [...]`.');
  console.log('');
  console.log('Flags:');
  console.log('  --target <path>   Override the install path');
  console.log('  --force           Overwrite existing plugin file (backs up to .bak)');
  console.log('');
  console.log('Example:');
  console.log('  opencues install plugin cues');
}

function printHelp(ctx) {
  console.log(`opencues install <host> [options]`);
  console.log('');
  console.log('Install a host integration. Each host has the same flags + behaviour as');
  console.log('its per-integration installer (see integrations/<host>/bin/install.cjs).');
  console.log('');
  console.log('Hosts:');
  console.log('  claude-code   Patches Claude Code\'s cli.js via tweakcc       (aliases: claudecode, claude, cc)');
  console.log('  opencode      Patches an OpenCode 1.4.x fork                 (alias: oc)');
  console.log('  chrome        Chrome MV3 extension');
  console.log('  gemini-cli    Patches a Gemini CLI 0.41.x fork               (aliases: geminicli, gemini)');
  console.log('  shell         Standalone Bun + OpenTUI shell wrapper        (aliases: term, terminal, oc-shell, oc-edit)');
  console.log('  --all         Install all five');
  console.log('');
  console.log('Special subcommands:');
  console.log('  skill <name>  Install a shipped Claude skill (see `opencues install skill --help`)');
  console.log('  plugin <name> Install an opencode plugin (see `opencues install plugin --help`)');
  console.log('');
  console.log('Common flags (passed through to the per-host installer):');
  console.log('  --target <path>   Host install path (cli.js for claude-code, fork dir for opencode/gemini-cli)');
  console.log('  --dry-run         Print plan, do not execute');
  console.log('  --clean           (claude-code) wipe install dir before reinstalling; (gemini-cli) accepted as no-op alias');
  console.log('  --no-build        (chrome only) skip build, use existing dist/');
  console.log('');
  console.log('Examples:');
  console.log('  opencues install claude-code');
  console.log('  opencues install claude-code --target ~/claude-code-cues/.../cli.js');
  console.log('  opencues install --all --dry-run');
  console.log('  opencues install skill cues');
}
