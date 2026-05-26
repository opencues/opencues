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
      HOSTS: ['chrome', 'claude-code', 'gemini-cli', 'opencode', 'terminal'],
      resolve: (name) => {
        const map = {
          'claude-code': 'claude-code', 'claudecode': 'claude-code',
          'claude': 'claude-code', 'cc': 'claude-code',
          'opencode': 'opencode', 'oc': 'opencode',
          'chrome': 'chrome', 'chrome-host': 'chrome',
          'gemini-cli': 'gemini-cli', 'geminicli': 'gemini-cli',
          'gemini': 'gemini-cli',
          'terminal': 'terminal', 'term': 'terminal', 'oc-edit': 'terminal',
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
  console.log('  terminal      Standalone Bun + OpenTUI app (oc-edit)         (aliases: term, oc-edit)');
  console.log('  --all         Install all five');
  console.log('');
  console.log('Special subcommands:');
  console.log('  skill <name>  Install a shipped Claude skill (see `opencues install skill --help`)');
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
