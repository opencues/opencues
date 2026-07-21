// `opencues doctor` — cross-host diagnostics. Read-only inspection of
// install state across all integrations. Suggests fixes for what it
// finds wrong.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const compatLib = require('../lib/compat.cjs');
const { tag, bold, dim, green, yellow, banner, fileLink, G, cliVersion } = require('../lib/style.cjs');

// Build a section accumulator. ok/bad rows lead with a status ring (green ●
// present / gray ● absent); info/raw rows have a blank gutter. `raw` keeps its
// custom end marker (a tag, not an existence tick).
function section(title, description) {
  const rows = []; // { label, value, ring:boolean|null, marker? }
  return {
    ok:   (label, present) => rows.push({ label, value: '', ring: !!present }),
    bad:  (label, present) => rows.push({ label, value: '', ring: !!present }),
    info: (label, value)   => rows.push({ label, value: value || '', ring: null }),
    raw:  (label, value, marker) => rows.push({ label, value: value || '', ring: null, marker: marker || '' }),
    render: () => {
      console.log(bold(title) + (description ? '  ' + dim(description) : ''));
      const w = Math.max(0, ...rows.map(r => r.label.length));
      for (const r of rows) {
        const ring = r.ring === null ? '  ' : (r.ring ? green(G.ringOn) : dim(G.ringOn)) + ' ';
        const tail = r.marker ? '  ' + r.marker : '';
        console.log(`  ${ring}${r.label.padEnd(w)}  ${r.value}${tail}`.replace(/\s+$/, ''));
      }
      console.log('');
    },
  };
}

module.exports = async function doctor(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  const HOME = os.homedir();
  const findings = [];

  // Single source of truth for what features + config files OpenCues
  // knows about. Load lazily so `opencues doctor --help` works even
  // when core isn't built yet.
  let registry, providers, effectiveRouting;
  try {
    registry = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/feature-registry.js'));
    providers = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/llm-provider.js'));
    effectiveRouting = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/effective-routing.js'));
  } catch (err) {
    console.error('opencues doctor: failed to load @opencues/core (run `pnpm build`):', err.message);
    return 1;
  }
  // Existing-key detection (shell env + ~/.cues/.env). Optional — an
  // older built core without env-keys.js degrades to env-only checks.
  let envKeysMod = null;
  try {
    envKeysMod = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/env-keys.js'));
  } catch { /* env-only fallback below */ }

  console.log(banner({ version: cliVersion(ctx), tagline: 'cross-host install diagnostics' }));
  console.log('');

  // ── Workspace ─────────────────────────────────────────────────────────
  {
    const s = section('Workspace', 'the opencues clone you are running from');
    const wsDir = ctx.REPO_ROOT;
    const wsLockfile = path.join(wsDir, 'pnpm-lock.yaml');
    const wsBuilt = path.join(wsDir, 'packages/opencues-runtime/dist/src/index.js');
    s.ok(`opencues clone at ${wsDir}`, fs.existsSync(wsDir));
    s.ok(`pnpm-lock.yaml present`, fs.existsSync(wsLockfile));
    if (!fs.existsSync(wsBuilt)) {
      findings.push({ sev: 'warn', msg: '@opencues/runtime not built', fix: 'pnpm build' });
      s.bad(`@opencues/runtime built (${wsBuilt})`, false);
    } else {
      s.ok(`@opencues/runtime built`, true);
    }
    s.render();
  }

  // ── Platform tooling ──────────────────────────────────────────────────
  // Pre-install gates (package.json `"os"` + `"engines"`) catch the
  // wrong-OS / wrong-Node case at `npm install` time. This section
  // surfaces the SOFT runtime tooling so the user can see what `opencues
  // install` preflight warned about earlier without re-running install.
  {
    const s = section('Platform tooling', 'developer tools + shells the installers/runtime touch');

    // Node version (declared in package.json engines as >=22).
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    s.ok(`node ${process.versions.node}`, nodeMajor >= 22);
    if (nodeMajor < 22) {
      findings.push({
        sev: 'warn',
        msg: `Node ${process.versions.node} — opencues requires >=22`,
        fix: 'install Node 22+ via fnm / nvm / brew / apt',
      });
    }

    // git — every fork-cloning installer needs it (CC, OC, gemini).
    s.ok('git on PATH', !!findOnPath('git'));
    if (!findOnPath('git')) {
      findings.push({
        sev: 'warn',
        msg: 'git not on PATH — every fork-cloning installer (CC, OC, gemini) will fail',
        fix: process.platform === 'darwin' ? 'xcode-select --install (or brew install git)' :
             'apt install git  (or `dnf install git` / `pacman -S git`)',
      });
    }

    // pnpm — required for the workspace install + many integration builds.
    s.ok('pnpm on PATH', !!findOnPath('pnpm'));
    if (!findOnPath('pnpm')) {
      findings.push({
        sev: 'info',
        msg: 'pnpm not on PATH — required for workspace install + several integration builds',
        fix: 'corepack enable pnpm  (Node 16+ ships it) — or `npm install -g pnpm`',
      });
    }

    // bash version — bash 3.2 (macOS default) works for everything we
    // ship; bash 4+ is strongly recommended on macOS for third-party
    // blank scripts (mapfile, declare -A, ${var^^}).
    try {
      const { execSync } = require('child_process');
      const out = execSync('/bin/bash --version 2>/dev/null', { encoding: 'utf8' });
      const m = out.match(/version (\d+)\.(\d+)/);
      if (m) {
        const maj = parseInt(m[1], 10), min = parseInt(m[2], 10);
        s.ok(`bash ${maj}.${min}`, maj >= 3 && (maj > 3 || min >= 2));
        if (process.platform === 'darwin' && maj < 4) {
          findings.push({
            sev: 'info',
            msg: `bash is ${maj}.x — third-party blank scripts that use bash 4+ (mapfile, declare -A, \${var^^}) will fail`,
            fix: 'brew install bash',
          });
        }
      }
    } catch { /* /bin/bash unavailable — skip */ }

    // tmux — only matters for the shell integration. The shell install
    // vendors its own tmux 3.4 at ~/.opencues/vendor/tmux/bin/tmux when
    // the system tmux is < 3.2; oc-shell uses that vendored binary
    // automatically. So the system-tmux check is only load-bearing when
    // the vendored binary is absent (user planning to install shell but
    // hasn't run the installer yet). When vendored tmux ≥ 3.2 is
    // present, the system version is informational only — no finding.
    const HOME = os.homedir();
    const vendoredTmux = path.join(HOME, '.opencues/vendor/tmux/bin/tmux');
    const vendoredVersion = (() => {
      if (!fs.existsSync(vendoredTmux)) return null;
      try {
        const out = require('child_process').execSync(`${JSON.stringify(vendoredTmux)} -V 2>/dev/null`, { encoding: 'utf8' });
        const m = out.match(/tmux (\d+)\.(\d+)/);
        return m ? { maj: parseInt(m[1], 10), min: parseInt(m[2], 10) } : null;
      } catch { return null; }
    })();
    const vendoredOk = vendoredVersion && (vendoredVersion.maj > 3 || (vendoredVersion.maj === 3 && vendoredVersion.min >= 2));
    try {
      const { execSync } = require('child_process');
      const out = execSync('tmux -V 2>/dev/null', { encoding: 'utf8' });
      const m = out.match(/tmux (\d+)\.(\d+)/);
      if (m) {
        const maj = parseInt(m[1], 10), min = parseInt(m[2], 10);
        const sysOk = maj > 3 || (maj === 3 && min >= 2);
        // Pass when either path satisfies. Show the vendored fallback
        // inline so the user knows what oc-shell will actually use.
        s.ok(
          `tmux ${maj}.${min} (shell integration)` + (vendoredOk ? ` ${dim(`— vendored ${vendoredVersion.maj}.${vendoredVersion.min} also present, oc-shell uses that`)}` : ''),
          sysOk || vendoredOk,
        );
        if (!sysOk && !vendoredOk) {
          findings.push({
            sev: 'info',
            msg: `tmux ${maj}.${min} — shell integration needs 3.2+ for display-popup`,
            fix: process.platform === 'darwin' ? 'brew install tmux' :
                 'apt install tmux  (or `dnf install tmux` / `pacman -S tmux`)',
          });
        }
      } else if (vendoredOk) {
        s.ok(`tmux (vendored ${vendoredVersion.maj}.${vendoredVersion.min} at ~/.opencues/vendor)`, true);
      } else {
        s.info('tmux on PATH (shell integration)', dim('(not found — needed for `opencues install shell`)'));
      }
    } catch {
      if (vendoredOk) {
        s.ok(`tmux (vendored ${vendoredVersion.maj}.${vendoredVersion.min} at ~/.opencues/vendor)`, true);
      } else {
        s.info('tmux on PATH (shell integration)', dim('(not found — needed for `opencues install shell`)'));
      }
    }

    // bun — needed by both shell (oc-edit) AND opencode. Listed here so
    // it surfaces before the per-host section flags it again.
    const bunFound = !!findOnPath('bun');
    s.ok('bun on PATH (shell + opencode)', bunFound);
    if (!bunFound) {
      findings.push({
        sev: 'info',
        msg: 'bun not on PATH — opencode and oc-shell both need it',
        fix: 'curl -fsSL https://bun.sh/install | bash',
      });
    }

    s.render();
  }

  // ── Feature backends (OS tools per feature) ───────────────────────────
  // Each row maps to a runtime feature that silently degrades (no-op,
  // default value, exit 127) if its backend tool is absent.
  //
  // WSL parity rule: on WSL the colocated .exe (VolCtl, BrightCtl,
  // SpeakCtl) is the PRIMARY backend the bash scripts try first — see
  // defaults/blanks/{volume,brightness}/*-blank.sh and
  // defaults/scripts/speak.sh. The Linux tools (pactl, brightnessctl,
  // espeak-ng) are fallbacks only. So a WSL user with the .exe present
  // is FULLY covered and doctor must NOT emit a "no Linux tool"
  // finding for the same feature — that's misleading.
  {
    const s = section('Feature backends', 'OS tools per runtime feature — missing = silent degrade, not crash');

    const wslEnv = !!process.env.WSL_DISTRO_NAME || (function () {
      try { return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft'); }
      catch { return false; }
    })();

    const volExe = path.join(HOME, '.cues/blanks/volume/VolCtl.exe');
    const brightExe = path.join(HOME, '.cues/blanks/brightness/BrightCtl.exe');
    const speakExe = path.join(HOME, '.cues/scripts/SpeakCtl.exe');
    const psShell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
    const brightPs1 = path.join(HOME, '.cues/blanks/brightness/brightness-set.ps1');

    // ── volume blank ───────────────────────────────────────────────
    {
      const macOsa = process.platform === 'darwin' && !!findOnPath('osascript');
      const linWp = process.platform === 'linux' && !!findOnPath('wpctl');
      const linPa = process.platform === 'linux' && !!findOnPath('pactl');
      const linAm = process.platform === 'linux' && !!findOnPath('amixer');
      const wslExe = wslEnv && fs.existsSync(volExe);
      const wslNircmd = wslEnv && fs.existsSync('/mnt/c/Windows/nircmd.exe');
      const backends = [];
      if (wslExe) backends.push('VolCtl.exe (WSL, primary)');
      if (macOsa) backends.push('osascript (macOS built-in)');
      if (linWp) backends.push('wpctl');
      if (linPa) backends.push('pactl');
      if (linAm) backends.push('amixer');
      if (wslNircmd) backends.push('nircmd.exe (WSL fallback)');
      const covered = backends.length > 0;
      s.ok(`volume — ${covered ? backends.join(', ') : 'NONE'}`, covered);
      if (!covered) {
        findings.push({
          sev: 'info',
          msg: `\`volume _\` has no backend on this system — reads "50" + set is a no-op`,
          fix: wslEnv ? 'opencues seed-configs  # auto-compiles VolCtl.cs on WSL' :
               process.platform === 'darwin' ? 'unusual on macOS — osascript ships with the OS' :
               'apt install pulseaudio-utils  (or wireplumber / alsa-utils)',
        });
      }
    }

    // ── brightness blank ───────────────────────────────────────────
    {
      const macBright = process.platform === 'darwin' && !!findOnPath('brightness');
      const macDdc = process.platform === 'darwin' && !!findOnPath('ddcutil');
      const linCtl = process.platform === 'linux' && !!findOnPath('brightnessctl');
      const linDdc = process.platform === 'linux' && !!findOnPath('ddcutil');
      const wslExe = wslEnv && fs.existsSync(brightExe);
      const wslPs = wslEnv && fs.existsSync(psShell) && fs.existsSync(brightPs1);
      const backends = [];
      if (wslExe) backends.push('BrightCtl.exe (WSL, primary)');
      if (macBright) backends.push('brightness (macOS)');
      if (macDdc) backends.push('ddcutil');
      if (linCtl) backends.push('brightnessctl');
      if (linDdc) backends.push('ddcutil');
      if (wslPs) backends.push('powershell + brightness-set.ps1 (WSL fallback)');
      const covered = backends.length > 0;
      s.ok(`brightness — ${covered ? backends.join(', ') : 'NONE'}`, covered);
      if (!covered) {
        findings.push({
          sev: 'info',
          msg: `\`brightness _\` has no backend on this system — reads "50" + set is a no-op`,
          fix: wslEnv ? 'opencues seed-configs  # auto-compiles BrightCtl.cs on WSL' :
               process.platform === 'darwin' ? 'brew install brightness  (laptops) or `brew install ddcutil` (external DDC/CI)' :
               'apt install brightnessctl  (laptops) or `apt install ddcutil` (external DDC/CI)',
        });
      }
    }

    // ── voice-mode TTS ─────────────────────────────────────────────
    {
      const macSay = process.platform === 'darwin' && !!findOnPath('say');
      const linEspeak = process.platform === 'linux' && !!findOnPath('espeak-ng');
      const linSpd = process.platform === 'linux' && !!findOnPath('spd-say');
      const wslExe = wslEnv && fs.existsSync(speakExe);
      const wslPs = wslEnv && fs.existsSync(psShell); // SAPI fallback in speak.sh
      const backends = [];
      if (wslExe) backends.push('SpeakCtl.exe (WSL, primary)');
      if (macSay) backends.push('say (macOS built-in)');
      if (linEspeak) backends.push('espeak-ng');
      if (linSpd) backends.push('spd-say');
      if (wslPs) backends.push('powershell SAPI (WSL fallback)');
      const covered = backends.length > 0;
      s.ok(`TTS (voice-mode) — ${covered ? backends.join(', ') : 'NONE'}`, covered);
      if (!covered) {
        findings.push({
          sev: 'info',
          msg: 'TTS / voice-mode has no backend on this system — it\'s a silent no-op',
          fix: wslEnv ? 'opencues seed-configs  # auto-compiles SpeakCtl.cs on WSL' :
               process.platform === 'darwin' ? 'unusual on macOS — `say` ships with the OS' :
               'apt install espeak-ng  (or `apt install speech-dispatcher` → spd-say)',
        });
      }
    }

    // ── WSL: per-helper rows (so users see WHICH backend the scripts
    //    are using, and which fallback is available if the primary
    //    .exe is somehow missing). Suppress entirely off WSL.
    if (wslEnv) {
      s.ok(`WSL: ${volExe}`, fs.existsSync(volExe));
      s.ok(`WSL: ${brightExe}`, fs.existsSync(brightExe));
      s.ok(`WSL: ${speakExe}`, fs.existsSync(speakExe));
      const missing = [
        fs.existsSync(volExe) ? null : 'VolCtl.exe',
        fs.existsSync(brightExe) ? null : 'BrightCtl.exe',
        fs.existsSync(speakExe) ? null : 'SpeakCtl.exe',
      ].filter(Boolean);
      // Only suggest the seed re-run when AT LEAST ONE feature has no
      // WSL fallback either (otherwise the bash fallbacks handle it
      // silently and the user doesn't need to act).
      if (missing.length > 0) {
        findings.push({
          sev: 'info',
          msg: `WSL: missing helper(s) — ${missing.join(', ')}. Features fall back to slower paths (powershell / nircmd).`,
          fix: 'opencues seed-configs  # auto-compiles colocated .cs sources on WSL',
        });
      }
    }

    s.render();
  }

  // ── Configs ───────────────────────────────────────────────────────────
  const userConfigDir = path.join(HOME, '.cues');
  const projectConfigDir = path.join(process.cwd(), '.cues');
  {
    const s = section('Configs', 'user-level + project-level cue/blank search paths');
    s.ok(`user-level    ${userConfigDir}/`, fs.existsSync(userConfigDir));
    s.ok(`project-level ${projectConfigDir}/`, fs.existsSync(projectConfigDir));
    if (process.env.OPENCUES_HOME) {
      s.ok(`$OPENCUES_HOME → ${process.env.OPENCUES_HOME}/`, fs.existsSync(process.env.OPENCUES_HOME));
    }
    s.render();
  }
  if (!fs.existsSync(userConfigDir)) {
    findings.push({ sev: 'info', msg: 'no user-level configs', fix: 'opencues seed-configs' });
  }

  // ── Legacy USER.md / user-context-mode migration ──────────────────────
  // The May 2026 rename USER.md → SENTINELS.md + user-context-mode →
  // identity-context-mode is back-compat-supported by the runtime (config-loader.ts
  // reads both names). `opencues seed-configs` migrates legacy → new on
  // next run. Surface here so users who skip seed-configs see the hint.
  {
    const legacySentinelsFile = path.join(userConfigDir, 'USER.md');
    const newSentinelsFile    = path.join(userConfigDir, 'SENTINELS.md');
    const settingsFile        = path.join(userConfigDir, 'OPENCUES.md');
    if (fs.existsSync(legacySentinelsFile) && !fs.existsSync(newSentinelsFile)) {
      findings.push({
        sev: 'warn',
        msg: `${legacySentinelsFile} uses the legacy filename — runtime back-compat-reads it but new tooling expects SENTINELS.md`,
        fix: 'opencues seed-configs   # self-heals the rename (USER.md → SENTINELS.md) in place',
      });
    }
    if (fs.existsSync(legacySentinelsFile) && fs.existsSync(newSentinelsFile)) {
      findings.push({
        sev: 'warn',
        msg: `Both ${legacySentinelsFile} AND SENTINELS.md exist — the runtime loads SENTINELS.md; remove the legacy USER.md after confirming`,
      });
    }
    if (fs.existsSync(settingsFile)) {
      const text = fs.readFileSync(settingsFile, 'utf8');
      const hasLegacyScalar = /^user-context-mode:/m.test(text);
      const hasNewScalar    = /^identity-context-mode:/m.test(text);
      if (hasLegacyScalar && !hasNewScalar) {
        findings.push({
          sev: 'warn',
          msg: `${settingsFile} uses legacy scalar \`user-context-mode:\` — runtime back-compat-reads it but rename to \`identity-context-mode:\` is preferred`,
          fix: 'opencues seed-configs   # self-heals the scalar rename in place',
        });
      }
    }
  }

  // ── Feature wiring ────────────────────────────────────────────────────
  // Surface optional-feature state at the install boundary. Every row
  // here is derived from the FEATURES registry in @opencues/core. To
  // add a row, append a FeatureSpec to that registry — do NOT hardcode
  // a new s.info() call here. Drift between this section and the
  // runtime is the exact failure class the registry exists to prevent.
  {
    const s = section('Feature wiring', 'optional features + their prerequisites (sourced from @opencues/core FEATURES)');
    // Runtime canonical: ~/.cues/OPENCUES.md (via the registry's
    // CORE_SETTINGS_FILE constant). Native hosts (CC/OC/gemini-cli)
    // and chrome all read runtime scalars from there. CUES.md is a
    // separate file (cue master config + project metadata) that has
    // never carried runtime settings — a previous design plan to
    // merge them never landed.
    const settingsFile = path.join(userConfigDir, registry.CORE_SETTINGS_FILE);
    const scalars = readOpencuesScalars(settingsFile);

    // Show each registered feature's current value (or default if unset)
    for (const f of registry.FEATURES) {
      const defaultValue = f.values[0]?.id ?? f.values[0];  // ValueSpec.id or legacy string
      const value = scalars[f.scalar] != null ? scalars[f.scalar] : dim(`(${defaultValue})`);
      s.info(f.scalar, value);
    }

    // Show prerequisite-file presence for every feature that has one
    for (const f of registry.FEATURES) {
      if (!f.prereqFile) continue;
      const filePath = path.join(userConfigDir, f.prereqFile.basename);
      const populated = countPopulatedFields(filePath, f.prereqFile.basename);
      const label = `${f.prereqFile.basename} present (${populated.count} ${populated.unit})`;
      s.ok(label, fs.existsSync(filePath));
    }

    // Always-on core files (OPENCUES.md / CUES.md / AUDITORS.md).
    // OPENCUES.md is the canonical runtime-settings file (read by
    // ConfigLoader via OpenCuesSettingsBlank). CUES.md is the
    // cue-config master + carries project metadata; only some installs
    // have it co-located with settings (back-compat with the pre-2026
    // single-file layout). Skip showing OPENCUES.md if absent + CUES.md
    // present, to keep the section short.
    for (const basename of registry.CORE_CONFIG_FILES) {
      if (basename === 'OPENCUES.md' && !fs.existsSync(path.join(userConfigDir, basename))) continue;
      const filePath = path.join(userConfigDir, basename);
      const populated = countPopulatedFields(filePath, basename);
      const label = `${basename} present (${populated.count} ${populated.unit})`;
      s.ok(label, fs.existsSync(filePath));
    }
    s.render();

    // Cross-check: scalar set to non-default, but the feature's prereq
    // file is missing or empty → silently-inert feature. This is the
    // exact "I enabled it but nothing happens" failure we want to catch.
    for (const f of registry.FEATURES) {
      if (!f.prereqFile?.mustHavePopulatedFields) continue;
      const value = scalars[f.scalar];
      const defaultId = f.values[0]?.id ?? f.values[0];
      if (!value || value === defaultId) continue;  // default → not enabled, skip
      const filePath = path.join(userConfigDir, f.prereqFile.basename);
      const populated = countPopulatedFields(filePath, f.prereqFile.basename);
      if (populated.count > 0) continue;
      findings.push({
        sev: 'warn',
        msg: `${f.scalar}=${value} but ${f.prereqFile.basename} is missing or has no populated fields — the feature won't fire`,
        fix: fs.existsSync(filePath)
          ? `populate ${filePath} (see ${f.prereqFile.template || 'docs'} for the template)`
          : `opencues seed-configs   # creates ${f.prereqFile.basename} template; then edit ${filePath}`,
      });
    }
  }

  // ── CC install ────────────────────────────────────────────────────────
  const ccFork = path.join(HOME, 'claude-code-cues');
  const ccSupport = path.join(ccFork, '.cues');
  const ccCore = path.join(ccFork, 'node_modules/@opencues/core');
  const ccRuntime = path.join(ccFork, 'node_modules/@opencues/runtime');
  const ccBackup = path.join(ccSupport, 'patch-state/cli.js.backup');
  {
    const s = section('Claude Code (cc)', 'patched cli.js fork + installed runtime');
    reportPinStatus(s, 'claude-code', ctx, HOME, findings);
    s.ok(`fork dir     ${ccFork}/`, fs.existsSync(ccFork));
    s.ok(`support dir  ${ccSupport}/`, fs.existsSync(ccSupport));
    s.ok(`runtime`,    fs.existsSync(ccRuntime));
    s.ok(`core`,       fs.existsSync(ccCore));
    s.ok(`tweakcc backup`, fs.existsSync(ccBackup));
    const cliCandidates = [
      path.join(HOME, '.claude/node_modules/@anthropic-ai/claude-code/cli.js'),
      path.join(ccFork, 'node_modules/@anthropic-ai/claude-code/cli.js'),
    ];
    for (const cli of cliCandidates) {
      if (!fs.existsSync(cli)) continue;
      const content = fs.readFileSync(cli, 'utf8');
      const patched = content.includes('@opencues/runtime');
      s.ok(`${cli} → patched`, patched);
      if (!patched) {
        findings.push({ sev: 'warn', msg: `cli.js at ${cli} is not patched`, fix: `opencues install claude-code --target ${cli}` });
      }
    }
    // ── StatusLine opt-in surface (CC's settings.json) ──────────────
    // Status line tip is OPT-IN — install never touches ~/.claude/.
    // Surface user-level + project-level state distinctly so users
    // discover the command. Reuses the same lib statusline.cjs uses
    // so this view can't drift from what `opencues statusline status`
    // shows.
    try {
      const ccsl = require('../lib/cc-statusline.cjs');
      const userInfo = ccsl.inspect('user');
      const projectInfo = ccsl.inspect('project');

      // User-level row.
      if (userInfo.state === 'opencues-ours') {
        s.ok(`statusLine (user)`, true);
      } else if (userInfo.state === 'missing') {
        s.info(`statusLine (user)`, dim('not configured — opt-in: `opencues statusline enable`'));
      } else if (userInfo.state === 'opencues-stale') {
        s.bad(`statusLine (user) — stale opencues path`, false);
        findings.push({
          sev: 'warn',
          msg: `statusLine.command in ${userInfo.file} points at a stale opencues path (${userInfo.currentCmd})`,
          fix: 'opencues statusline enable   # rewrites to current install root',
        });
      } else if (userInfo.state === 'user-custom') {
        s.info(`statusLine (user) — custom`, dim(userInfo.currentCmd));
      } else if (userInfo.state === 'broken') {
        s.bad(`statusLine (user) — settings.json unreadable`, false);
      }

      // Project-level row. Only shown when something actually exists
      // at <cwd>/.claude/settings.json — otherwise this would yell at
      // every cwd that doesn't have CC project settings.
      if (fs.existsSync(projectInfo.file)) {
        if (projectInfo.state === 'opencues-ours') {
          s.ok(`statusLine (project: ${process.cwd()})`, true);
        } else if (projectInfo.state === 'missing') {
          s.info(`statusLine (project)`, dim(`project settings.json exists but no statusLine — opt-in: opencues statusline enable --project`));
        } else if (projectInfo.state === 'opencues-stale') {
          s.bad(`statusLine (project) — stale opencues path`, false);
          findings.push({
            sev: 'warn',
            msg: `statusLine.command in ${projectInfo.file} points at a stale opencues path (${projectInfo.currentCmd})`,
            fix: 'opencues statusline enable --project   # rewrites to current install root',
          });
        } else if (projectInfo.state === 'user-custom') {
          // Project-shadow case. User-level might be ours; project takes precedence.
          // Surface this prominently — it's the genuine "tips don't appear here, why?" case.
          if (userInfo.state === 'opencues-ours') {
            s.info(`statusLine (project) — SHADOWING user-level`, dim(projectInfo.currentCmd));
            findings.push({
              sev: 'info',
              msg: `OpenCues tips won't appear in CC launched from this project — ${projectInfo.file} sets its own statusLine.command (${projectInfo.currentCmd}) which takes precedence over your user-level configuration.`,
              fix: 'opencues statusline enable --project --force   # if you want to replace the project command\n         ' +
                   '(or `opencues statusline enable --project` after manually removing the project field)',
            });
          } else {
            s.info(`statusLine (project) — custom`, dim(projectInfo.currentCmd));
          }
        } else if (projectInfo.state === 'broken') {
          s.bad(`statusLine (project) — settings.json unreadable`, false);
        }
      }
    } catch { /* cc-statusline lib unavailable — non-fatal */ }
    s.render();
  }
  // Stale pre-compact-footprint install still on disk?
  const legacyCcRoot = path.join(HOME, '.claude/opencues');
  if (fs.existsSync(legacyCcRoot)) {
    findings.push({
      sev: 'warn',
      msg: `legacy install at ${legacyCcRoot}/ — re-run install to migrate to compact footprint`,
      fix: 'opencues install claude-code',
    });
  }
  // Detect extra CC fork dirs (e.g. ~/claude-code-cues-150/, -170/) +
  // check each one for drift. As of June 2026 the install/update path
  // fans out across every `~/claude-code-cues*` dir with a real CC
  // binary, so these forks are no longer "dev relics to delete" —
  // they're real install targets. Surface drift on each one (warn,
  // because stale = broken runtime), and surface truly-orphaned dirs
  // (no CC binary anywhere) as info ("safe to remove").
  try {
    const { enumerateCCForks, detectExtraCCForks, checkDrift } = require('../lib/version-markers.cjs');
    const canonicalCC = path.join(HOME, 'claude-code-cues');
    const allForks = enumerateCCForks();
    // Forks with a real CC binary → drift check.
    for (const fork of allForks) {
      if (fork.root === canonicalCC) continue; // canonical drift covered elsewhere
      const drift = checkDrift(path.join(fork.root, '.cues'), ctx);
      if (drift.status === 'stale') {
        findings.push({
          sev: 'warn',
          msg: `extra CC fork at ${fork.root}/ is STALE — bundled runtime ${drift.marker.runtime} vs source ${drift.source.runtime || '?'} (reason: ${drift.reason}). Direct launches of this fork run broken/old code.`,
          fix: `opencues install claude-code   # fans out across every fork`,
        });
      } else if (drift.status === 'missing') {
        findings.push({
          sev: 'warn',
          msg: `extra CC fork at ${fork.root}/ has no install marker — never patched, or patched pre-marker era. Direct launches of this fork won't load OpenCues.`,
          fix: `opencues install claude-code   # fans out across every fork`,
        });
      } else {
        findings.push({
          sev: 'info',
          msg: `extra CC fork at ${fork.root}/ — fresh (bundled runtime ${drift.marker.runtime}, srcHash matches). Multi-fork dev install detected.`,
        });
      }
    }
    // Orphan dirs: detectExtraCCForks finds every `claude-code-cues*`
    // dir; subtract the ones with a real binary (already handled
    // above) and report the rest as "safe to remove."
    const realForkRoots = new Set(allForks.map(f => f.root));
    for (const extra of detectExtraCCForks()) {
      if (realForkRoots.has(extra)) continue;
      findings.push({
        sev: 'info',
        msg: `extra dir at ${extra}/ — no CC binary inside. Likely an orphan from a prior layout; safe to delete.`,
        fix: `rm -rf ${extra}`,
      });
    }
  } catch { /* lib unavailable — skip */ }
  // Only surface "CC not installed" when the fork is actually absent.
  // If the fork is present (cli.js patched + runtime/core installed) but
  // .cues/ support dir is missing, it usually means the patch was
  // applied without the latest compact-footprint setup.sh — runtime
  // works fine, but tweakcc state + statusline + scripts live in the
  // wrong place. Surface that distinctly, not as "not installed".
  if (!fs.existsSync(ccFork)) {
    findings.push({ sev: 'info', msg: 'CC not installed', fix: 'opencues install claude-code' });
  } else if (!fs.existsSync(ccSupport)) {
    findings.push({ sev: 'info', msg: 'CC fork present but missing the .cues/ support dir (statusline script, tweakcc state). Runtime works; re-install to land the support files.', fix: 'opencues install claude-code' });
  }

  // ── OC install ────────────────────────────────────────────────────────
  {
    const s = section('OpenCode (oc)', 'patched OpenCode fork + installed runtime');
    reportPinStatus(s, 'opencode', ctx, HOME, findings);
    const ocFork = path.join(HOME, 'opencode-cues');
    if (fs.existsSync(ocFork)) {
      s.ok(`fork at ${ocFork}`, true);
      s.ok(`fork/node_modules/@opencues/runtime`, fs.existsSync(path.join(ocFork, 'node_modules/@opencues/runtime')));
      s.ok(`fork/node_modules/@opencues/core`,    fs.existsSync(path.join(ocFork, 'node_modules/@opencues/core')));
      const opencuesTs = path.join(ocFork, 'packages/opencode/src/cli/cmd/tui/opencues.ts');
      s.ok(`bootstrap copy in fork`, fs.existsSync(opencuesTs));
    } else {
      s.bad(`fork at ${ocFork}`, false);
      findings.push({ sev: 'info', msg: 'OC fork not present', fix: 'opencues install opencode' });
    }
    s.render();
  }

  // ── Chrome ────────────────────────────────────────────────────────────
  const chromeDist = path.join(ctx.REPO_ROOT, 'integrations/chrome/dist');
  const chromeContentJs = path.join(chromeDist, 'content.js');
  {
    const s = section('Chrome', 'MV3 extension build output');
    s.ok(`build output ${chromeDist}/`, fs.existsSync(chromeDist));
    s.ok(`content.js`, fs.existsSync(chromeContentJs));
    // WSL-only: compare repo dist mtime to whatever lives at the
    // Windows-loaded path. Drift means the user ran `npm run build`
    // but forgot to sync — Chrome runs stale code, no error, just no
    // new behaviour. The friction we hit personally during this ship.
    const wslEnv = !!process.env.WSL_DISTRO_NAME || (function () {
      try { return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft'); }
      catch { return false; }
    })();
    if (wslEnv && fs.existsSync(chromeContentJs)) {
      const winCandidates = findWindowsChromeUnpacked();
      for (const winDist of winCandidates) {
        const winContent = path.join(winDist, 'content.js');
        if (!fs.existsSync(winContent)) continue;
        // Compare CONTENT hashes, not mtimes. Mtimes change every
        // `pnpm build` even when the bundle output is byte-identical
        // (esbuild rewrites the file unconditionally), which produced
        // a false-positive "/mnt/c is stale" warning right after every
        // build — making the user think they had to re-sync when the
        // deployed extension was already current. Pre-June-2026 doctor
        // used mtimes; switched to SHA-256 content compare so the
        // warning fires only when the deployed file actually differs
        // from the repo's just-built file.
        const repoHash = sha256OfFile(chromeContentJs);
        const winHash = sha256OfFile(winContent);
        const fresh = repoHash === winHash;
        s.ok(`${winDist}/content.js matches repo dist`, fresh);
        if (!fresh) {
          findings.push({
            sev: 'warn',
            msg: `Chrome bundle at ${winDist}/ doesn't match the repo build — Chrome will run different code until you re-sync`,
            fix: `cp -r ${chromeDist}/* ${winDist}/ && cp ${path.join(ctx.REPO_ROOT, 'integrations/chrome/manifest.json')} ${path.dirname(winDist)}/manifest.json   # then reload at chrome://extensions`,
          });
        }
      }
    }
    s.render();
  }
  if (!fs.existsSync(chromeContentJs)) {
    findings.push({ sev: 'info', msg: 'Chrome extension not built', fix: 'opencues install chrome' });
  }

  // ── Chrome native-messaging host ──────────────────────────────────────
  // The host enables (a) live ~/.cues/ sync to chrome.storage and
  // (b) subprocess execution for scripted blanks like `volume _`. Without
  // it the extension still works from bake-time bundles, but any edit to
  // ~/.cues/ won't reach open tabs and scripted blanks exit 127.
  {
    const s = section('Chrome native-messaging host', 'live ~/.cues/ sync + scripted-blank execution');
    const wslEnv = !!process.env.WSL_DISTRO_NAME || (function () {
      try { return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft'); }
      catch { return false; }
    })();
    let manifestPaths = [];
    let shimPath = null;
    if (wslEnv) {
      // WSL → Chrome-on-Windows. Manifest + .bat shim land under
      // %LOCALAPPDATA%\opencues\. Walk /mnt/c/Users/*/ since the
      // Windows username may differ from $USER.
      try {
        const winUsers = fs.readdirSync('/mnt/c/Users', { withFileTypes: true })
          .filter(e => e.isDirectory() && !e.name.startsWith('.') && !['Public', 'Default', 'Default User', 'All Users'].includes(e.name));
        for (const u of winUsers) {
          const dir = `/mnt/c/Users/${u.name}/AppData/Local/opencues`;
          const m = `${dir}/com.opencues.sync.json`;
          const b = `${dir}/sync-host.bat`;
          if (fs.existsSync(m)) { manifestPaths.push(m); if (fs.existsSync(b) && !shimPath) shimPath = b; }
        }
      } catch { /* /mnt/c not accessible — host can't be installed here anyway */ }
    } else if (process.platform === 'darwin') {
      const home = HOME;
      manifestPaths = [
        `${home}/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.opencues.sync.json`,
        `${home}/Library/Application Support/Chromium/NativeMessagingHosts/com.opencues.sync.json`,
      ].filter(p => fs.existsSync(p));
    } else if (process.platform === 'linux') {
      const home = HOME;
      manifestPaths = [
        `${home}/.config/google-chrome/NativeMessagingHosts/com.opencues.sync.json`,
        `${home}/.config/chromium/NativeMessagingHosts/com.opencues.sync.json`,
      ].filter(p => fs.existsSync(p));
    }
    if (manifestPaths.length === 0) {
      s.info('native-messaging manifest', dim('(not installed)'));
      findings.push({
        sev: 'info',
        msg: 'Chrome native-messaging host not installed — live ~/.cues/ sync + scripted blanks (volume/brightness) won\'t work in chrome tabs',
        fix: 'opencues install chrome-host --extension-id <id>  (id from chrome://extensions, Developer mode)',
      });
    } else {
      for (const p of manifestPaths) s.ok(p, true);
      if (wslEnv) s.ok('sync-host.bat shim', !!shimPath);
      // File-push parity — the host script must push every config
      // file the runtime expects to read from chrome.storage. When a
      // new file (USER.md, AUDITORS.md, ...) is added on the runtime
      // side, the host script's hardcoded file list must be updated
      // too or the file is silently never pushed. We hit this in May
      // 2026 with SENTINELS.md.
      const hostScript = resolveHostScript(manifestPaths[0], shimPath);
      if (hostScript && fs.existsSync(hostScript)) {
        const text = fs.readFileSync(hostScript, 'utf8');
        const required = registry.chromeHostFileList();
        // A host script that derives its push list from the FEATURES
        // registry (chromeHostFileList) structurally cannot drift — new
        // pushed-by-host files are picked up with zero host.cjs changes,
        // so their basenames never appear as literals in the script.
        // Pre-derive host scripts hardcoded the names; for those (only)
        // the literal grep below is the right parity check. Grepping a
        // derived script for literals false-positived on NOTES.md +
        // calendar.json (July 2026) purely because nobody had mentioned
        // them in a comment.
        const derivesFromRegistry = text.includes('chromeHostFileList');
        const missing = derivesFromRegistry ? [] : required.filter(f => !text.includes(f));
        s.ok(
          derivesFromRegistry
            ? 'host derives push list from FEATURES registry (chromeHostFileList)'
            : `host pushes [${required.join(', ')}]`,
          missing.length === 0,
        );
        if (missing.length > 0) {
          findings.push({
            sev: 'warn',
            msg: `chrome-host script at ${hostScript} doesn't push ${missing.join(', ')} — those config files will never reach the extension`,
            fix: 'opencues install chrome-host --extension-id <id>   # re-installs from current repo',
          });
        }
      }
    }
    s.render();
  }

  // ── Terminal install (standalone Bun + OpenTUI app) ──────────────────
  // No upstream fork — staged @opencues/{core,runtime} live inside the
  // repo at integrations/shell/node_modules/. Bun is a hard prereq.
  {
    const s = section('Terminal (oc-edit)', 'standalone Bun + OpenTUI app');
    const termDir = path.join(ctx.REPO_ROOT, 'integrations/shell');
    const termRt = path.join(termDir, 'node_modules/@opencues/runtime');
    const termCore = path.join(termDir, 'node_modules/@opencues/core');
    const ocEditBin = path.join(termDir, 'bin/oc-edit');
    s.ok(`integration dir at ${termDir}`, fs.existsSync(termDir));
    s.ok(`bin/oc-edit`, fs.existsSync(ocEditBin));
    s.ok(`node_modules/@opencues/runtime (staged)`, fs.existsSync(termRt));
    s.ok(`node_modules/@opencues/core (staged)`, fs.existsSync(termCore));
    s.ok(`bun on PATH`, !!findOnPath('bun'));
    if (!findOnPath('bun')) {
      findings.push({
        sev: 'warn',
        msg: 'bun not on PATH — shell integration needs Bun',
        fix: 'curl -fsSL https://bun.sh/install | bash   # then re-run setup',
      });
    }
    if (!fs.existsSync(termRt)) {
      findings.push({ sev: 'info', msg: 'Shell integration not installed', fix: 'opencues install shell' });
    }
    s.render();
  }

  // ── Gemini CLI install ────────────────────────────────────────────────
  {
    const s = section('Gemini CLI', 'patched Gemini CLI fork + installed runtime');
    reportPinStatus(s, 'gemini-cli', ctx, HOME, findings);
    const geminiFork = path.join(HOME, 'gemini-cli-cues');
    if (fs.existsSync(geminiFork)) {
      s.ok(`fork at ${geminiFork}`, true);
      s.ok(`fork/node_modules/@opencues/runtime`, fs.existsSync(path.join(geminiFork, 'node_modules/@opencues/runtime')));
      s.ok(`fork/node_modules/@opencues/core`,    fs.existsSync(path.join(geminiFork, 'node_modules/@opencues/core')));
      const geminiBootstrap = path.join(geminiFork, 'packages/cli/src/ui/opencues.ts');
      s.ok(`bootstrap copy in fork`, fs.existsSync(geminiBootstrap));
      const geminiBuilt = path.join(geminiFork, 'packages/cli/dist/index.js');
      s.ok(`built CLI`, fs.existsSync(geminiBuilt));
    } else {
      s.bad(`fork at ${geminiFork}`, false);
      findings.push({ sev: 'info', msg: 'Gemini CLI fork not present', fix: 'opencues install gemini-cli' });
    }
    s.render();
  }

  // ── Apple Notes install ───────────────────────────────────────────────
  // Self-owned JXA polling daemon (macOS only). The one check that
  // matters most is the Automation TCC permission: a cached deny fails
  // INSTANTLY with -1743 and NO dialog (the silent-deny trap — see
  // integrations/apple-notes/NOTES-PLATFORM.md § TCC), which from the
  // user's side is indistinguishable from "OpenCues is broken".
  {
    const s = section('Apple Notes', 'JXA polling daemon for Notes.app (macOS only)');
    if (process.platform !== 'darwin') {
      s.info('platform', 'not macOS — apple-notes integration unavailable here');
    } else {
      const anDir = path.join(ctx.REPO_ROOT, 'integrations/apple-notes');
      const anDaemon = path.join(anDir, 'dist/daemon.js');
      const anRt = path.join(anDir, 'node_modules/@opencues/runtime/dist');
      const anCore = path.join(anDir, 'node_modules/@opencues/core/dist');
      s.ok(`integration dir at ${anDir}`, fs.existsSync(anDir));
      s.ok('dist/daemon.js (built)', fs.existsSync(anDaemon));
      s.ok('node_modules/@opencues/runtime (staged)', fs.existsSync(anRt));
      s.ok('node_modules/@opencues/core (staged)', fs.existsSync(anCore));
      s.ok('osascript on PATH', !!findOnPath('osascript'));
      if (!fs.existsSync(anDaemon)) {
        findings.push({ sev: 'info', msg: 'Apple Notes integration not installed', fix: 'opencues install apple-notes' });
      } else {
        // Automation permission probe — one Apple Event (folder count).
        // 10s timeout: a first-ever probe may block on the TCC dialog;
        // timing out is reported as "prompt pending", not a failure.
        const probe = spawnSync('osascript', ['-l', 'JavaScript', path.join(anDir, 'jxa/probe-permission.js')], {
          encoding: 'utf8', timeout: 10000,
        });
        if (probe.status === 0) {
          s.ok('Notes automation permission (TCC)', true);
        } else if ((probe.stderr || '').includes('-1743')) {
          s.bad('Notes automation permission (TCC)', false);
          findings.push({
            sev: 'warn',
            msg: 'Notes automation DENIED (TCC -1743) — a cached deny is silent: no prompt will ever appear',
            fix: 'System Settings → Privacy & Security → Automation → your terminal → enable Notes;\n' +
                 '        or re-arm the prompt: tccutil reset AppleEvents <terminal-bundle-id>  (e.g. com.apple.Terminal)',
          });
        } else {
          s.raw('Notes automation permission (TCC)', '', tag('warn') + ' ' + dim('probe inconclusive (prompt pending or Notes unavailable)'));
        }
      }
    }
    s.render();
  }

  // ── mac (universal AX host) install ───────────────────────────────────
  // Self-owned Accessibility daemon (macOS only). The load-bearing check
  // is the Accessibility TCC grant — a DIFFERENT permission class from
  // apple-notes' Automation grant; `ax-bridge status` checks it without
  // firing the system prompt (doctor must never pop dialogs).
  {
    const s = section('mac (universal AX host)', 'answers `_` cues in the focused text element of any app (macOS only)');
    if (process.platform !== 'darwin') {
      s.info('platform', 'not macOS — mac integration unavailable here');
    } else {
      const macDir = path.join(ctx.REPO_ROOT, 'integrations/mac');
      const macDaemon = path.join(macDir, 'dist/daemon.js');
      const macBridge = path.join(macDir, 'dist/ax-bridge');
      const macRt = path.join(macDir, 'node_modules/@opencues/runtime/dist');
      s.ok(`integration dir at ${macDir}`, fs.existsSync(macDir));
      s.ok('dist/daemon.js (built)', fs.existsSync(macDaemon));
      s.ok('dist/ax-bridge (built)', fs.existsSync(macBridge));
      s.ok('node_modules/@opencues/runtime (staged)', fs.existsSync(macRt));
      if (!fs.existsSync(macDaemon) || !fs.existsSync(macBridge)) {
        findings.push({ sev: 'info', msg: 'mac integration not installed', fix: 'opencues install mac' });
      } else {
        const probe = spawnSync(macBridge, ['status'], { encoding: 'utf8', timeout: 5000 });
        if ((probe.stdout || '').trim() === 'trusted') {
          s.ok('Accessibility permission (TCC)', true);
        } else {
          s.bad('Accessibility permission (TCC)', false);
          findings.push({
            sev: 'warn',
            msg: 'Accessibility permission NOT granted — the mac daemon cannot see or edit any text element',
            fix: 'System Settings → Privacy & Security → Accessibility → enable the app that launches the daemon;\n' +
                 '        then restart it: opencues run mac',
          });
        }
      }
    }
    s.render();
  }

  // ── OS-level sandbox ──────────────────────────────────────────────────
  // Per-platform confiner used to wrap `sandbox: strict` user-blank
  // script invocations. Mechanism:
  //   - Linux / WSL2 → bubblewrap (`bwrap`) — needs `apt install bubblewrap`.
  //   - macOS → `sandbox-exec` (Apple's seatbelt) — ships with the OS.
  //   - Other → no confiner wired; falls through unwrapped.
  // See packages/opencues-runtime/src/security/sandbox-runner.ts §
  // wrapForPlatform for the dispatcher.
  //
  // F9 (INFOSEC): the sandbox is opt-in. A scripted blank that doesn't
  // declare `sandbox: strict` runs with the user's full filesystem +
  // network privileges regardless of whether bwrap/sandbox-exec is
  // installed. We now also surface the count of installed scripted
  // blanks that AREN'T opted in, so the unwrapped-by-default footgun
  // is visible to the user instead of being something they have to
  // discover by reading the F9 finding.
  let sandboxMechanismOK = false;
  {
    const s = section('OS-level sandbox', 'wraps `blankScript: sandbox: strict` runs in an OS confinement layer');
    if (process.platform === 'linux') {
      const bwrap = findOnPath('bwrap');
      const wslEnv = !!process.env.WSL_DISTRO_NAME || (function () {
        try { return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft'); }
        catch { return false; }
      })();
      const platLabel = wslEnv ? 'WSL2 (Linux)' : 'Linux';
      s.ok(`${platLabel}: bwrap (bubblewrap) on PATH`, !!bwrap);
      sandboxMechanismOK = !!bwrap;
      if (!bwrap) {
        findings.push({
          sev: 'warn',
          msg: 'bubblewrap (bwrap) not installed — scripted blanks with `sandbox: strict` will run UNWRAPPED (no confinement)',
          fix: 'apt install bubblewrap   (Debian/Ubuntu)\n         dnf install bubblewrap   (Fedora/RHEL)\n         pacman -S bubblewrap     (Arch)',
        });
      }
    } else if (process.platform === 'darwin') {
      const sbx = fs.existsSync('/usr/bin/sandbox-exec');
      s.ok(`macOS: sandbox-exec at /usr/bin/sandbox-exec (Apple seatbelt)`, sbx);
      sandboxMechanismOK = sbx;
      if (!sbx) {
        findings.push({
          sev: 'warn',
          msg: 'sandbox-exec missing — strict-sandbox blanks will run unwrapped on this Mac',
          fix: 'unusual — sandbox-exec ships with macOS. Check /usr/bin/.',
        });
      }
    } else {
      s.info(`platform ${process.platform}`, dim('no OS sandbox mechanism wired — strict-sandbox blanks run unwrapped'));
      findings.push({
        sev: 'warn',
        msg: `no OS sandbox available for platform "${process.platform}" — strict-sandbox blanks run unwrapped`,
        fix: 'use macOS or Linux/WSL2 for confined blanks; otherwise treat `sandbox: strict` as documentation only',
      });
    }

    // F9: scan installed scripted blanks and report how many are
    // opt-in to strict sandbox vs running unconfined. Catches the
    // common case where the user has bwrap installed but their
    // blanks don't declare `sandbox: strict`, so it's a no-op.
    const scriptedBlanks = scanScriptedBlanks(HOME);
    if (scriptedBlanks.total > 0) {
      const strictCount = scriptedBlanks.strict;
      const intactCount = scriptedBlanks.shippedIntact;
      const ackOffCount = scriptedBlanks.sandboxOff;
      const modifiedCount = scriptedBlanks.userModified;
      // The warning gate is ONLY user-modified blanks. Three exemptions:
      //   - `sandbox: strict`: confined under bwrap / sandbox-exec.
      //   - shipped-intact: hash-matches the artefacts the user already
      //     opted into by running `opencues install`; their (typically
      //     `sandbox: off`) policy is the repo's deliberate design.
      //   - `sandbox: off`: explicit author/user ack of host privileges
      //     (F9 contract — same as the runtime's load-time check).
      // Modified-and-unacknowledged blanks are the surface the user
      // can act on — they either added it locally or a pack shadowed a
      // shipped name with different bytes (hash-mismatch).
      const trustedCount = strictCount + intactCount + ackOffCount;
      const trustedParts = [];
      if (strictCount > 0) trustedParts.push(`${strictCount} strict`);
      if (intactCount > 0) trustedParts.push(`${intactCount} shipped-intact`);
      if (ackOffCount > 0) trustedParts.push(`${ackOffCount} sandbox:off ack`);
      const trustedSuffix = trustedParts.length > 0 ? ` (${trustedParts.join(' + ')})` : '';
      if (modifiedCount === 0) {
        s.ok(`scripted blanks trusted (${trustedCount}/${scriptedBlanks.total})${trustedSuffix}`, true);
      } else {
        s.bad(`scripted blanks trusted (${trustedCount}/${scriptedBlanks.total})${trustedSuffix} — ${modifiedCount} user-modified run UNCONFINED`, false);
        findings.push({
          sev: sandboxMechanismOK ? 'warn' : 'warn',
          msg: `${modifiedCount} of ${scriptedBlanks.total} installed scripted blanks are user-modified (or pack-shadowed) and run with the user's full filesystem + network privileges` +
               (scriptedBlanks.userModifiedPaths.length ? `\n         examples: ${scriptedBlanks.userModifiedPaths.slice(0, 3).join(', ')}` : ''),
          // For blanks whose work fundamentally needs unsandboxed
          // access (system audio, brightness, hardware bridges), the
          // shipped defaults declare `sandbox: off` deliberately —
          // adding `sandbox: strict` would break them. Tell the user
          // to either move to strict (if the blank's work allows it)
          // or audit the script + acknowledge by setting
          // `sandbox: off`.
          fix: 'audit the script. If it can run confined, add `sandbox: strict` to BLANK.md. If it genuinely needs host privileges (e.g. system audio/brightness/hardware), declare `sandbox: off` to acknowledge that explicitly. Otherwise remove the blank.',
        });
      }
    } else {
      s.info('no scripted blanks installed', dim('— sandbox status N/A'));
    }
    s.render();
  }

  // ── Env / API keys ────────────────────────────────────────────────────
  // Sourced from @opencues/core's PROVIDERS registry — same list
  // check-keys probes + host.cjs pushes. Display order follows
  // PROVIDER_AUTO_ORDER (the actual auto-fallback chain) so the
  // first-line provider is the one a fresh user without configured
  // overrides will hit.
  {
    const s = section('Environment', 'API keys from shell env + ~/.cues/.env (opencues set-key)');
    // Per-key source detection via core's env-keys module: shell env
    // wins over ~/.cues/.env, mirroring what the hosts boot with.
    const keySources = envKeysMod
      ? Object.fromEntries(envKeysMod.detectProviderKeys().map((d) => [d.envKeyName, d.source]))
      : null;
    const fileEnv = envKeysMod ? envKeysMod.readCuesEnvFile() : {};
    const sourceOf = (envName) => keySources
      ? (keySources[envName] ?? (process.env[envName] ? 'shell-env' : null))
      : (process.env[envName] ? 'shell-env' : null);
    const keyLabel = (base, envName) =>
      sourceOf(envName) === 'env-file' ? `${base} · via ~/.cues/.env` : base;
    const order = providers.PROVIDER_AUTO_ORDER;
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const adapter = providers.getProvider(id);
      if (!adapter) continue;
      const suffix = i === 0 ? ' (LLM — auto-pick when set)' : ' (LLM)';
      s.ok(keyLabel(`${adapter.envKeyName}${suffix}`, adapter.envKeyName), !!sourceOf(adapter.envKeyName));
    }
    // Show every other LLM provider (e.g. openrouter, intentionally
    // excluded from PROVIDER_AUTO_ORDER as a routing layer) so doctor
    // still surfaces whether the user has that key set.
    for (const adapter of providers.listProviders()) {
      if (order.includes(adapter.id)) continue;
      // CLI-transport providers (claude-cli) have no env key — auth
      // is external (via the user's `claude` install). Skip here;
      // they get their own check block below.
      if (adapter.transport === 'cli' || !adapter.envKeyName) continue;
      s.ok(keyLabel(`${adapter.envKeyName} (LLM)`, adapter.envKeyName), !!sourceOf(adapter.envKeyName));
    }
    // Non-LLM service keys — kept hardcoded; one entry today (FINNHUB
    // for the stocks blank). Lift into a SERVICE_KEYS registry when
    // there's a second one. NOTE: script-facing keys still come from
    // process.env at spawn time (the .env file feeds LLM dispatch only),
    // so a file-only FINNHUB key is shown but flagged.
    const finnhubSrc = process.env.FINNHUB_API_KEY ? 'shell-env' : (fileEnv.FINNHUB_API_KEY ? 'env-file' : null);
    s.ok(
      finnhubSrc === 'env-file'
        ? 'FINNHUB_API_KEY (stocks blank) · in ~/.cues/.env — scripts need a shell export'
        : 'FINNHUB_API_KEY (stocks blank)',
      !!finnhubSrc,
    );
    s.render();
  }
  // ── LLM routing (three buckets) ────────────────────────────────────────
  // Show effective resolution per bucket so users can audit where each
  // surface is calling. Precedence shown: bucket scalar > global
  // `llm-provider:` > auto-fallback (first env key in
  // PROVIDER_AUTO_ORDER). Per-aspect overrides (`word-cues-provider:`,
  // `fluid-blank-provider:`, etc.) win above bucket — they aren't
  // displayed inline to keep the section compact; users edit OPENCUES.md
  // directly for those.
  {
    const s = section('LLM routing', 'per-bucket effective provider (bucket scalar > global > auto)');
    const settingsFile = path.join(userConfigDir, registry.CORE_SETTINGS_FILE);
    const scalars = readOpencuesScalars(settingsFile);
    // Bag mirrors what a native host boots with — shell env + ~/.cues/.env
    // via core's buildBootApiKeys — so the displayed auto-pick matches the
    // runtime's actual resolution.
    let apiKeysFromEnv;
    if (envKeysMod) {
      apiKeysFromEnv = envKeysMod.buildBootApiKeys();
    } else {
      apiKeysFromEnv = {};
      for (const adapter of providers.listProviders()) {
        if (adapter.envKeyName) apiKeysFromEnv[adapter.envKeyName] = process.env[adapter.envKeyName];
      }
    }
    // Shared walk — the exact code dispatch runs (core's
    // effective-routing.ts, also behind the `model` blank and `opencues
    // models`). Doctor used to reimplement the precedence inline and
    // drifted from dispatch three ways (July 2026: global-model leak
    // into pinned buckets, inert bucket-model on inherit, raw auditors
    // sentinels); requiring the shared module makes the display
    // structurally unable to disagree with dispatch.
    const routing = effectiveRouting.resolveEffectiveRouting({
      scalars: (name) => scalars[name],
      apiKeys: apiKeysFromEnv,
    });
    const SOURCE_TAGS = {
      global: 'llm-provider',
      'auto-key': 'auto (env key)',
      'auto-subscription': 'auto (subscription CLI — no keys set)',
    };
    for (const bucket of effectiveRouting.LLM_BUCKETS) {
      const row = routing[bucket];
      if (!row.provider) {
        s.info(`${bucket}:`, row.providerId
          ? `${row.providerId} ${dim('(unknown provider — LLM calls disabled for this bucket)')}`
          : dim('(none — no key + no scalar set)'));
      } else {
        const srcTag = SOURCE_TAGS[row.providerSource] ? dim(` (← ${SOURCE_TAGS[row.providerSource]})`) : '';
        const keyNote = row.keyPresent ? '' : '  ' + yellow('key missing');
        s.info(`${bucket}:`, `${row.providerId} · ${row.model}${srcTag}${keyNote}`);
        if (row.trainsOnInputBlocked) {
          findings.push({
            sev: 'warn',
            msg: `${bucket} bucket routes to ${row.providerId}, which trains on input — prose-bearing buckets refuse this provider, so every ${bucket}-bucket LLM call is disabled until another provider is picked.`,
          });
        }
        if (!row.keyPresent && (row.providerSource === 'bucket' || row.providerSource === 'global')) {
          findings.push({
            sev: 'warn',
            msg: `${bucket}: provider ${row.providerId} is configured but its key/binary is unavailable — every ${bucket}-bucket LLM call silently no-ops. Fix: opencues set-key`,
          });
        }
      }
      if (row.ignoredBucketProviderScalar) {
        findings.push({
          sev: 'warn',
          msg: `${bucket}-llm-provider: "${row.ignoredBucketProviderScalar}" is not a known provider id — runtime treats it as inherit. Known: ${providers.PROVIDER_IDS.join(', ')}.`,
        });
      }
      // Warn if the user wrote a literal "default"/"inherit" — it
      // works (runtime treats it as fall-through) but it's confusing
      // and a sign the menu cycle wrote a sentinel into a scalar
      // expecting a real model name. Surface it so the user can
      // clean it up.
      const modelScalarName = `${bucket}-llm-model`;
      const modelScalarRaw = scalars[modelScalarName];
      if (modelScalarRaw && effectiveRouting.normalizeModelScalar(modelScalarRaw) === undefined) {
        findings.push({
          sev: 'info',
          msg: `${modelScalarName}: "${modelScalarRaw}" is a fall-through sentinel — runtime treats it as unset and dispatches with ${row.model || 'the provider default'}. Delete this line if you want the global llm-model + provider default, or replace it with a real model name.`,
        });
      }
    }
    s.render();
  }
  // CLI-transport providers (subscription-backed) probed separately.
  // Today: claude-cli only. Checks the binary is on PATH; we DON'T
  // probe `claude auth status` because that spawns a subprocess every
  // doctor run — slow + noisy. Users see a runtime error from the
  // daemon if auth has expired, which is recoverable via `claude auth`.
  {
    const cliProviders = providers.listProviders().filter(p => p.transport === 'cli');
    if (cliProviders.length > 0) {
      const s = section('Subscription providers', 'CLI-transport providers that use external auth (no env key)');
      const { spawnSync } = require('child_process');
      for (const adapter of cliProviders) {
        // Binary per CLI-transport provider — from core's registry map
        // (the same one pickAutoProvider's zero-key subscription rung
        // probes), defaulting to the id for any future CLI provider
        // whose binary matches its id.
        const bin = providers.SUBSCRIPTION_CLI_BINARIES?.[adapter.id] || adapter.id;
        const which = spawnSync('which', [bin], { encoding: 'utf8' });
        const installed = which.status === 0;
        s.ok(`${adapter.displayName} (${bin} on PATH)`, installed);
        if (!installed) {
          const FIX_BY_ID = {
            'claude-code-cli': `install Claude Code from https://claude.com/code, run \`claude auth\`, then \`claude -p hi\` to confirm`,
            'openai-subscription': `install OpenAI Codex via \`npm i -g @openai/codex\`, then run \`codex login\` to sign in with your ChatGPT plan (writes ~/.codex/auth.json which the runtime reads on every call — the codex binary is not on the request hot path)`,
          };
          findings.push({
            sev: 'info',
            msg: `${adapter.displayName} provider needs the \`${bin}\` CLI installed — set \`agent-rewrite-provider: ${adapter.id}\` etc. in OPENCUES.md once installed`,
            fix: FIX_BY_ID[adapter.id] || `install ${bin}, authenticate it, then re-run`,
          });
        }
      }
      s.render();
    }
  }
  // No LLM provider key set → every LLM-driven cue/blank is inert.
  // hasAnyLlmKey iterates the registry so adding a provider auto-counts.
  // CLI-transport providers don't have an env key — they count as "key
  // present" when their binary is installed (probed in the block above).
  const hasAnyLlmKey = envKeysMod
    ? envKeysMod.detectProviderKeys().some((d) => d.source)
    : providers.listProviders().some(p => {
        if (p.transport === 'cli') return false; // doesn't count toward "no key" check
        return !!process.env[p.envKeyName];
      });
  if (!hasAnyLlmKey) {
    // Zero keys — but the runtime's auto-route has a subscription-CLI
    // rung (claude/codex binary present → claude-code-cli /
    // openai-subscription). When that rung would fire, the setup WORKS:
    // downgrade to info naming the route + the faster path.
    const subscriptionPick = providers.pickAutoProvider?.({}) ?? null;
    const subscriptionAdapter = subscriptionPick ? providers.getProvider(subscriptionPick) : null;
    if (subscriptionAdapter?.transport === 'cli') {
      findings.push({
        sev: 'info',
        msg: `no API keys — LLM calls route through your ${providers.SUBSCRIPTION_CLI_BINARIES?.[subscriptionPick] ?? subscriptionPick} subscription (${subscriptionPick}). Works out of the box; slower than the API tier`,
        fix: 'opencues set-key (a stored API key automatically takes over the auto-route)',
      });
    } else {
      const firstChoice = providers.getProvider(providers.PROVIDER_AUTO_ORDER[0]);
      findings.push({
        sev: 'warn',
        msg: 'no LLM provider key set — every LLM-driven cue/blank will be inert',
        fix: `opencues set-key ${firstChoice?.id ?? 'cerebras'} (stores in ~/.cues/.env, read at host boot) — or export ${firstChoice?.envKeyName ?? 'CEREBRAS_API_KEY'}=...`,
      });
    }
  } else {
    // First-in-auto-order key missing AND a non-default provider is set
    // → user has likely overridden llm-provider:, verify their setup.
    const top = providers.getProvider(providers.PROVIDER_AUTO_ORDER[0]);
    const topSet = envKeysMod
      ? envKeysMod.detectProviderKeys().some((d) => d.providerId === top?.id && d.source)
      : !!(top && process.env[top.envKeyName]);
    if (top && !topSet) {
      findings.push({
        sev: 'info',
        msg: `${top.envKeyName} unset — auto-fallback's first choice (${top.displayName}) won't pick; ensure CUES.md / OPENCUES.md sets \`llm-provider:\` to a host you have a key for`,
        fix: 'opencues check-keys',
      });
    }
  }

  // ── Runtime IPC files ─────────────────────────────────────────────────
  {
    const s = section('Runtime IPC', 'files created on disk when a host actually runs');
    s.ok('/tmp/opencues.log', fs.existsSync('/tmp/opencues.log'));
    const cursorState = '/tmp/opencues-cursor-state-<pid>.json';
    s.ok(cursorState, fs.existsSync(cursorState));
    s.render();
  }

  // ── Bundled-runtime drift ─────────────────────────────────────────────
  // Each host install writes a version.json marker recording the
  // @opencues/runtime + @opencues/core versions that landed. We compare
  // those against the current source build — any mismatch means the
  // bundle is older than source and `opencues update` (or `opencues
  // install <host>`) needs to run. This catches the May 2026 dual-CC-fork
  // bug class: source has the fix, one fork's bundle doesn't.
  {
    const s = section('Bundled runtime', '<host>/.opencues/version.json vs current source @opencues/{core,runtime}');
    const { enumerateInstalledHosts } = require('../lib/version-markers.cjs');
    const installed = enumerateInstalledHosts(ctx);
    if (installed.length === 0) {
      s.info('no installed hosts detected', dim('(install a host to populate this section)'));
    } else {
      for (const { host, root, drift } of installed) {
        if (drift.status === 'fresh') {
          s.ok(`${host} — runtime ${drift.marker.runtime} / core ${drift.marker.core}`, true);
        } else if (drift.status === 'stale') {
          s.bad(`${host} — runtime ${drift.marker.runtime} (source ${drift.source.runtime || '?'})`, false);
          findings.push({
            sev: 'warn',
            msg: `${host} has stale bundled runtime (${drift.marker.runtime}) vs source (${drift.source.runtime}). Caused the May 2026 dual-fork bug.`,
            fix: `opencues install ${host}    # rebuild + re-deploy the runtime into ${root}`,
          });
        } else /* missing */ {
          s.info(`${host}`, dim(`(no version marker — install pre-dates marker era OR install was external)`));
          findings.push({
            sev: 'info',
            msg: `${host} has no version marker. Re-run install to write one so future updates can detect drift.`,
            fix: `opencues install ${host}`,
          });
        }
      }
    }
    s.render();
  }

  // ── Summary ───────────────────────────────────────────────────────────
  if (findings.length === 0) {
    console.log(`${tag('ok')} no issues found.`);
    await maybePrintUpdateNotice(ctx);
    return 0;
  }
  console.log(bold('Suggested fixes') + dim(`  (${findings.length})`));
  console.log('');
  // Warnings first, then info notices — most actionable at the top.
  const ordered = [...findings].sort((a, b) => (a.sev === 'warn' ? 0 : 1) - (b.sev === 'warn' ? 0 : 1));
  for (const f of ordered) {
    // Big ring: yellow ● = warning, gray ● = info notice.
    const mark = f.sev === 'warn' ? yellow(G.ringOn) : dim(G.ringOn);
    console.log(`  ${mark} ${f.msg}`);
    if (f.fix) console.log(`     ${dim(f.fix)}`);
  }
  await maybePrintUpdateNotice(ctx);
  const errors = findings.filter(f => f.sev === 'warn').length;
  const infos = findings.filter(f => f.sev === 'info').length;
  // Return the exit code instead of calling process.exit from a library
  // function. The CLI entry point (bin/cli.cjs) honours numeric return
  // values; tests can inspect the return value without process.exit
  // killing the runtime mid-assertion.
  //
  // --strict (added June 2026): treat ANY finding — info OR warn — as
  // a failure. Makes `opencues doctor --strict` usable as a one-line
  // CI gate ("the project is healthy → exit 0; else → exit 1"). The
  // non-strict default keeps info-level findings advisory so doctor
  // stays useful interactively without spurious failures from soft
  // notices (e.g. "tested version newer-tested available").
  if (argv.includes('--strict')) {
    return (errors + infos) > 0 ? 1 : 0;
  }
  return errors > 0 ? 1 : 0;
};

// Doctor does a network fetch to check the registry (acceptable —
// inspection commands are expected to query things). Fail-silent.
async function maybePrintUpdateNotice(ctx) {
  try {
    const { checkForUpdate, formatNotice } = require('../lib/update-check.cjs');
    const notice = await checkForUpdate(cliVersion(ctx));
    const msg = formatNotice(notice);
    if (msg) {
      console.log('');
      console.log(`${tag('info')} ${msg}`);
    }
  } catch { /* fail-silent */ }
}

// F9 (INFOSEC): scan ~/.cues/blanks/ + $OPENCUES_HOME/blanks/ for
// every BLANK.md that declares `blankScript:` and check whether it
// also declares `sandbox: strict`. Returns the counts so doctor can
// surface "X of Y scripted blanks run unconfined" — the unwrapped-
// by-default footgun the F9 finding called out.
//
// Best-effort YAML — we only need to spot the two scalars. The
// runtime's CUES.md / cues-md.ts parser is the authoritative one;
// this is purely diagnostic.
function scanScriptedBlanks(home) {
  const roots = [
    path.join(home, '.cues', 'blanks'),
    process.env.OPENCUES_HOME ? path.join(process.env.OPENCUES_HOME, 'blanks') : null,
  ].filter(Boolean);
  // Manifest categorises an unstrict blank as either `shippedIntact`
  // (every file hash-matches the shipped artefact — trust inherited
  // from the repo at install time) or `userModified` (the warning
  // case the user can actually act on). A pack masquerading under
  // a shipped name (e.g. ships its own `volume-blank.sh`) will hash-
  // mismatch and land in userModified.
  const manifest = loadShippedManifest();
  const result = {
    total: 0,
    strict: 0,
    sandboxOff: 0,
    sandboxOffPaths: [],
    shippedIntact: 0,
    shippedIntactPaths: [],
    userModified: 0,
    userModifiedPaths: [],
    unstrictPaths: [], // legacy field — kept for back-compat with the doctor render below
  };
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const blankDir = path.join(root, entry.name);
      const blankMd = path.join(blankDir, 'BLANK.md');
      if (!fs.existsSync(blankMd)) continue;
      let text;
      try { text = fs.readFileSync(blankMd, 'utf8'); }
      catch { continue; }
      const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      const fm = fmMatch[1];
      // Only count blanks that actually shell out.
      const hasScript = /^\s*blankScript\s*:/m.test(fm);
      if (!hasScript) continue;
      result.total++;
      const sandboxMatch = fm.match(/^\s*sandbox\s*:\s*(\w+)/m);
      const sandboxValue = sandboxMatch ? sandboxMatch[1] : null;
      if (sandboxValue === 'strict') {
        result.strict++;
        continue;
      }
      // Mirror of the runtime's INFOSEC F9 contract (blank-fill.ts:506-520):
      // authors must declare EITHER `sandbox: strict` (confined) OR
      // `sandbox: off` (explicit acknowledgement of host privileges).
      // `off` doesn't add confinement, but it does prove the author or
      // user inspected the script — silencing the warn for an explicitly
      // acknowledged blank keeps the signal on un-audited surfaces.
      if (sandboxValue === 'off') {
        result.sandboxOff++;
        result.sandboxOffPaths.push(entry.name);
        continue;
      }
      // Neither strict nor off: shipped-intact vs user-modified.
      if (isShippedIntact(entry.name, blankDir, manifest)) {
        result.shippedIntact++;
        result.shippedIntactPaths.push(entry.name);
      } else {
        result.userModified++;
        result.userModifiedPaths.push(entry.name);
        result.unstrictPaths.push(entry.name);
      }
    }
  }
  return result;
}

// Loads `packages/opencues-core/dist/shipped-manifest.json` (emitted
// by `scripts/build-shipped-manifest.cjs` at core build time). Returns
// null when the manifest is missing — every unstrict blank then falls
// through to userModified (the SAFE default — better to over-warn
// than silently exempt). Builds re-emit the manifest, so a fresh
// install always has one.
function loadShippedManifest() {
  try {
    const corePath = require.resolve('@opencues/core/package.json', {
      paths: [path.resolve(__dirname, '../../..')],
    });
    const manifestPath = path.join(path.dirname(corePath), 'dist/shipped-manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!raw || raw.version !== 1 || !raw.blanks) return null;
    return raw.blanks;
  } catch { return null; }
}

// Returns true iff the user-level <blankDir> hash-matches every entry
// in manifest[name]. Any extra file in the user dir (e.g. a colocated
// helper the user added) means NOT intact — the surface they're
// running is larger than what we shipped. Missing file (e.g. the
// shipped .cs that hasn't been compiled yet) also means NOT intact —
// we don't reason about which absences are benign.
//
// Compiled artefacts like .exe are excluded from the manifest at
// generation time (`EXCLUDE_EXT`), so they don't break the equality —
// the user-level dir holding the freshly-compiled VolCtl.exe is still
// considered intact as long as BLANK.md + .sh + .cs match.
function isShippedIntact(name, blankDir, manifest) {
  if (!manifest || !manifest[name]) return false;
  const expected = manifest[name];
  const expectedKeys = Object.keys(expected);
  let entries;
  try { entries = fs.readdirSync(blankDir, { withFileTypes: true }); }
  catch { return false; }
  // Build the set of files in the user dir that should be in the
  // manifest (skipping the same EXCLUDE_EXT compiled artefacts the
  // manifest skipped).
  const userFiles = entries
    .filter(d => d.isFile() && !d.name.startsWith('.') && !d.name.endsWith('.exe'))
    .map(d => d.name)
    .sort();
  if (userFiles.length !== expectedKeys.length) return false;
  const crypto = require('node:crypto');
  for (const f of expectedKeys) {
    const userPath = path.join(blankDir, f);
    if (!fs.existsSync(userPath)) return false;
    let raw = fs.readFileSync(userPath);
    // BLANK.md may carry a "user-only fields" block that `opencues
    // seed-configs` appends below a divider line to preserve hand-
    // tweaked fields across shipped-md refreshes (see
    // packages/opencues-cli/src/commands/seed-configs.cjs § append
    // user-only keys). Stripping the block before hashing lets a
    // vanilla install whose only divergence is the preserved suffix
    // still register as shipped-intact instead of being warn'd as
    // user-modified. The manifest's hash is over the shipped frontmatter
    // ONLY, so we strip the same block here for symmetry.
    if (f === 'BLANK.md') {
      raw = Buffer.from(stripUserOnlyFieldsBlock(raw.toString('utf8')), 'utf8');
    }
    const h = crypto.createHash('sha256');
    h.update(raw);
    if (h.digest('hex') !== expected[f]) return false;
  }
  return true;
}

// Mirror of the divider emitted by `seed-configs.cjs:879`. Anything from
// that line through the close of the frontmatter is user-only and
// excluded from the shipped-intact hash. Idempotent on text that has
// no divider (returns input verbatim).
const USER_ONLY_DIVIDER = '# ── User-only fields (preserved by shipped-md refresh) ──';
function stripUserOnlyFieldsBlock(text) {
  const fmMatch = text.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) return text;
  const open = fmMatch[1];
  const fm = fmMatch[2];
  const close = fmMatch[3];
  const idx = fm.indexOf(USER_ONLY_DIVIDER);
  if (idx < 0) return text;
  // Strip the divider and any newline immediately preceding it so the
  // frontmatter content ends right after the last shipped field.
  let cutStart = idx;
  while (cutStart > 0 && fm[cutStart - 1] === '\n') cutStart--;
  const cleanedFm = fm.slice(0, cutStart);
  const rest = text.slice(fmMatch[0].length);
  return open + cleanedFm + close + rest;
}

// Read OPENCUES.md (or CUES.md) frontmatter and return a flat
// {scalar: value} map. Best-effort YAML — only top-level
// `key: value` lines, no nesting. Missing file → empty object.
function readOpencuesScalars(file) {
  if (!file || !fs.existsSync(file)) return {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return {}; }
  if (!text || !text.length) return {};
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};
  const out = {};
  for (const line of fmMatch[1].split('\n')) {
    const m = line.match(/^([a-z][a-z0-9-]*)\s*:\s*(.*?)\s*(#.*)?$/i);
    if (!m) continue;
    const k = m[1].trim();
    let v = m[2].trim();
    // strip surrounding quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v.length === 0) continue;  // bare key — skip
    out[k] = v;
  }
  return out;
}

// Count "populated entries" in a config file, choosing the metric
// appropriate to the file's shape. Returns {count, unit} so the
// renderer can say "11 fields" vs "3 auditors" etc.
function countPopulatedFields(file, basename) {
  if (!file || !fs.existsSync(file)) return { count: 0, unit: 'fields' };
  // AUDITORS.md uses `### name` blocks
  if (basename === 'AUDITORS.md') {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const matches = text.match(/^###\s+\S/gm);
      const n = matches ? matches.length : 0;
      return { count: n, unit: n === 1 ? 'auditor' : 'auditors' };
    } catch { return { count: 0, unit: 'auditors' }; }
  }
  // CUES.md / OPENCUES.md / SENTINELS.md → frontmatter scalar count
  const n = Object.keys(readOpencuesScalars(file)).length;
  // CUES.md is special — it's also a cue config, so "frontmatter
  // fields" is the right metric for the always-on settings half.
  return { count: n, unit: n === 1 ? 'field' : 'fields' };
}

// WSL helper — find every unpacked-extension `dist/` directory the
// user may have placed under %LOCALAPPDATA%. Returns the dist paths
// (not the parent extension dirs). Used by the bundle-freshness check.
function findWindowsChromeUnpacked() {
  const out = [];
  try {
    const users = fs.readdirSync('/mnt/c/Users', { withFileTypes: true })
      .filter(e => e.isDirectory() && !['Public', 'Default', 'Default User', 'All Users'].includes(e.name));
    for (const u of users) {
      const base = `/mnt/c/Users/${u.name}/AppData/Local`;
      for (const candidate of ['opencues-chrome', 'opencues']) {
        const dist = path.join(base, candidate, 'dist');
        if (fs.existsSync(dist)) out.push(dist);
      }
    }
  } catch { /* not WSL or /mnt/c not accessible */ }
  return out;
}

// Read a native-messaging manifest and resolve the host script path
// it points at. For WSL setups the manifest points at a .bat shim;
// the shim's last `node <path>` line is the real host.cjs.
function resolveHostScript(manifestPath, shimPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const target = manifest.path;
    if (!target) return null;
    // Windows path → WSL path translation
    let normalized = target;
    if (target.match(/^[A-Z]:\\/i)) {
      normalized = '/mnt/' + target[0].toLowerCase() + target.slice(2).replace(/\\/g, '/');
    }
    // If it's a .bat shim, read it for the node invocation
    if (normalized.endsWith('.bat') || (shimPath && fs.existsSync(shimPath))) {
      const bat = fs.existsSync(normalized) ? normalized : shimPath;
      const batText = fs.readFileSync(bat, 'utf8');
      const m = batText.match(/node\s+(\S+\.cjs)/);
      if (m) return m[1];
    }
    return normalized;
  } catch { return null; }
}

// SHA-256 of a file's content. Returns null on any read error.
// Used by the chrome /mnt/c sync check so it compares CONTENT
// rather than mtimes — mtimes change every esbuild run even when
// the bundle is byte-identical, producing false-positive "stale
// /mnt/c" warnings right after every `pnpm build`.
function sha256OfFile(p) {
  try {
    const crypto = require('node:crypto');
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch { return null; }
}

// Resolve a binary on $PATH. Returns the absolute path or null.
function findOnPath(bin) {
  const PATH = process.env.PATH || '';
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && (st.mode & 0o111)) return candidate;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Print a one-line pin-status check for the given integration.
 * Reads compat.json + the local pin (no network — that's `update --check`).
 * Surfaces drift: pin is tested / pin is in compat-range but untested ⚠ /
 * pin is incompatible (shouldn't happen because installer should refuse,
 * but check anyway).
 */
function reportPinStatus(s, host, ctx, HOME, findings) {
  const compat = compatLib.loadCompat(ctx.REPO_ROOT, host);
  if (!compat) return;
  let pin = null;
  if (compat['host-kind'] === 'npm') {
    pin = compatLib.readNpmPin(HOME, compat);
  } else if (compat['host-kind'] === 'git') {
    const g = compatLib.readGitPin(ctx.REPO_ROOT, compat);
    if (g) pin = g.version;
  }
  if (!pin) return; // not installed yet — other checks will flag it
  const cls = compatLib.classifyVersion(pin, compat);
  const tested = (compat.tested || [])
    .map(t => typeof t === 'string' ? t : t.version);
  const latestTested = tested.length ? tested[tested.length - 1] : null;
  if (cls.status === 'tested') {
    if (latestTested && pin !== latestTested) {
      s.ok(`pin status   ${pin} (tested, but ${latestTested} is newer-tested)`, true);
    } else {
      s.ok(`pin status   ${pin} (tested)`, true);
    }
  } else if (cls.status === 'compat-untested') {
    s.bad(`pin status   ${pin} (in compat-range ${compat['compat-range']}, NOT tested)`, false);
    findings.push({
      sev: 'info',
      msg: `${host}: pin ${pin} is in compat-range but not in maintainer's tested list`,
      fix: latestTested ? `opencues update ${host} --to ${latestTested}  (or test + add to compat.json)` : `add ${pin} to integrations/${host}/compat.json's "tested" list once verified`,
    });
  } else if (cls.status === 'incompatible') {
    s.bad(`pin status   ${pin} (KNOWN INCOMPATIBLE: ${cls.reason})`, false);
    findings.push({
      sev: 'warn',
      msg: `${host}: pin ${pin} is known-incompatible (${cls.reason})`,
      fix: latestTested ? `opencues update ${host} --to ${latestTested}` : `pick a tested version + opencues update ${host} --to <v>`,
    });
  } else if (cls.status === 'out-of-range') {
    s.bad(`pin status   ${pin} (OUT OF compat-range ${compat['compat-range']})`, false);
    findings.push({
      sev: 'warn',
      msg: `${host}: pin ${pin} is outside compat-range ${compat['compat-range']}`,
      fix: latestTested ? `opencues update ${host} --to ${latestTested}` : `pick a version in ${compat['compat-range']} + opencues update ${host} --to <v>`,
    });
  }
}

function printHelp() {
  console.log('opencues doctor');
  console.log('');
  console.log('Cross-host install diagnostics. Read-only inspection that walks every');
  console.log('install path, every config search path, and every runtime IPC file');
  console.log('OpenCues might create. Reports what it found + suggested fixes for any');
  console.log('issues.');
  console.log('');
  console.log('Exit codes:');
  console.log('  0 = no warnings (default) / no findings at all (--strict)');
  console.log('  1 = warnings present (default) / any finding present (--strict)');
  console.log('');
  console.log('Flags:');
  console.log('  --strict   Treat info findings as failures too. Suitable for use as');
  console.log('             a one-line CI gate or as the final step of scripts/pre-pr.sh.');
}

// Internal helpers exposed for testing. Not part of the public surface.
module.exports._internal = { scanScriptedBlanks, loadShippedManifest, isShippedIntact };
