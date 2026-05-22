// `opencues doctor` — cross-host diagnostics. Read-only inspection of
// install state across all integrations. Suggests fixes for what it
// finds wrong.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const compatLib = require('../lib/compat.cjs');
const { tag, bold, dim, banner, fileLink, tree, existsMark, G, cliVersion } = require('../lib/style.cjs');

// Build a section accumulator: ok/bad push rows; render emits as a tree.
function section(title, description) {
  const rows = [];
  return {
    ok:   (label, present) => rows.push([label, '', existsMark(present)]),
    bad:  (label, present) => rows.push([label, '', existsMark(present)]),
    info: (label, value)   => rows.push([label, value || '']),
    raw:  (label, value, marker) => rows.push([label, value || '', marker || '']),
    render: () => { console.log(tree({ title, description, rows })); console.log(''); },
  };
}

module.exports = function doctor(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  const HOME = os.homedir();
  const findings = [];

  // Single source of truth for what features + config files OpenCues
  // knows about. Load lazily so `opencues doctor --help` works even
  // when core isn't built yet.
  let registry, providers;
  try {
    registry = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/feature-registry.js'));
    providers = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/llm-provider.js'));
  } catch (err) {
    console.error('opencues doctor: failed to load @opencues/core (run `pnpm build`):', err.message);
    return 1;
  }

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
  const ccSupport = path.join(ccFork, '.opencues');
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
  // Only surface "CC not installed" when the fork is actually absent.
  // If the fork is present (cli.js patched + runtime/core installed) but
  // .opencues/ support dir is missing, it usually means the patch was
  // applied without the latest compact-footprint setup.sh — runtime
  // works fine, but tweakcc state + statusline + scripts live in the
  // wrong place. Surface that distinctly, not as "not installed".
  if (!fs.existsSync(ccFork)) {
    findings.push({ sev: 'info', msg: 'CC not installed', fix: 'opencues install claude-code' });
  } else if (!fs.existsSync(ccSupport)) {
    findings.push({ sev: 'info', msg: 'CC fork present but missing the .opencues/ support dir (statusline script, tweakcc state). Runtime works; re-install to land the support files.', fix: 'opencues install claude-code' });
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
        const repoMtime = fs.statSync(chromeContentJs).mtimeMs;
        const winMtime = fs.statSync(winContent).mtimeMs;
        const fresh = repoMtime <= winMtime + 1000;  // 1s slop for cp delay
        s.ok(`${winDist}/content.js up-to-date with repo dist`, fresh);
        if (!fresh) {
          findings.push({
            sev: 'warn',
            msg: `Chrome bundle at ${winDist}/ is older than the repo build — Chrome will run stale code until you re-sync`,
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
      // 2026 with USER.md.
      const hostScript = resolveHostScript(manifestPaths[0], shimPath);
      if (hostScript && fs.existsSync(hostScript)) {
        const text = fs.readFileSync(hostScript, 'utf8');
        const required = registry.chromeHostFileList();
        const missing = required.filter(f => !text.includes(f));
        s.ok(`host pushes [${required.join(', ')}]`, missing.length === 0);
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

  // ── OS-level sandbox ──────────────────────────────────────────────────
  {
    const s = section('OS-level sandbox', 'wraps `blankScript: sandbox: strict` runs in an OS confinement layer');
    if (process.platform === 'linux') {
      const bwrap = findOnPath('bwrap');
      s.ok(`bwrap (bubblewrap) on PATH`, !!bwrap);
      if (!bwrap) {
        findings.push({
          sev: 'warn',
          msg: 'bubblewrap (bwrap) not installed — scripted blanks with `sandbox: strict` will run unwrapped',
          fix: 'apt install bubblewrap   (Debian/Ubuntu)\n         dnf install bubblewrap   (Fedora/RHEL)\n         pacman -S bubblewrap     (Arch)',
        });
      }
    } else if (process.platform === 'darwin') {
      const sbx = fs.existsSync('/usr/bin/sandbox-exec');
      s.ok(`sandbox-exec at /usr/bin/sandbox-exec`, sbx);
      if (!sbx) {
        findings.push({
          sev: 'warn',
          msg: 'sandbox-exec missing — strict-sandbox blanks will run unwrapped on this Mac',
          fix: 'unusual — sandbox-exec ships with macOS. Check /usr/bin/.',
        });
      }
    } else {
      s.info(`platform ${process.platform}`, dim('no OS sandbox mechanism wired yet'));
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
    const s = section('Environment', 'API keys exported in this shell session');
    const order = providers.PROVIDER_AUTO_ORDER;
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const adapter = providers.getProvider(id);
      if (!adapter) continue;
      const suffix = i === 0 ? ' (LLM — auto-pick when set)' : ' (LLM)';
      s.ok(`${adapter.envKeyName}${suffix}`, !!process.env[adapter.envKeyName]);
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
      s.ok(`${adapter.envKeyName} (LLM)`, !!process.env[adapter.envKeyName]);
    }
    // Non-LLM service keys — kept hardcoded; one entry today (FINNHUB
    // for the stocks blank). Lift into a SERVICE_KEYS registry when
    // there's a second one.
    s.ok('FINNHUB_API_KEY (stocks blank)', !!process.env.FINNHUB_API_KEY);
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
        // claude-cli looks for `claude` on PATH by default
        const bin = adapter.id === 'claude-cli' ? 'claude' : adapter.id;
        const which = spawnSync('which', [bin], { encoding: 'utf8' });
        const installed = which.status === 0;
        s.ok(`${adapter.displayName} (${bin} on PATH)`, installed);
        if (!installed) {
          findings.push({
            sev: 'info',
            msg: `${adapter.displayName} provider needs the \`${bin}\` CLI installed — set \`agent-rewrite-provider: ${adapter.id}\` etc. in OPENCUES.md once installed`,
            fix: `install Claude Code from https://claude.com/code, run \`${bin} auth\`, then \`${bin} -p hi\` to confirm`,
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
  const hasAnyLlmKey = providers.listProviders().some(p => {
    if (p.transport === 'cli') return false; // doesn't count toward "no key" check
    return !!process.env[p.envKeyName];
  });
  if (!hasAnyLlmKey) {
    const firstChoice = providers.getProvider(providers.PROVIDER_AUTO_ORDER[0]);
    findings.push({
      sev: 'warn',
      msg: 'no LLM provider key set — every LLM-driven cue/blank will be inert',
      fix: `export ${firstChoice?.envKeyName ?? 'GROQ_API_KEY'}=... (or another supported provider)`,
    });
  } else {
    // First-in-auto-order key missing AND a non-default provider is set
    // → user has likely overridden llm-provider:, verify their setup.
    const top = providers.getProvider(providers.PROVIDER_AUTO_ORDER[0]);
    if (top && !process.env[top.envKeyName]) {
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
    const cursorState = '/tmp/opencues-cursor-state.json';
    s.ok(cursorState, fs.existsSync(cursorState));
    s.render();
  }

  // ── Summary ───────────────────────────────────────────────────────────
  if (findings.length === 0) {
    console.log(`${tag('ok')} no issues found.`);
    return 0;
  }
  console.log(bold('## Suggested fixes'));
  for (const f of findings) {
    console.log(`  ${tag(f.sev === 'warn' ? 'warn' : 'info')} ${f.msg}`);
    console.log(`     ${dim(G.arrow)} ${f.fix}`);
  }
  const errors = findings.filter(f => f.sev === 'warn').length;
  // Return the exit code instead of calling process.exit from a library
  // function. The CLI entry point (bin/cli.cjs) honours numeric return
  // values; tests can inspect the return value without process.exit
  // killing the runtime mid-assertion.
  return errors > 0 ? 1 : 0;
};

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
  // CUES.md / OPENCUES.md / USER.md → frontmatter scalar count
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
 * Surfaces drift: pin is tested ✓ / pin is in compat-range but untested ⚠ /
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
      s.ok(`pin status   ${pin} (tested ✓)`, true);
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
  console.log('Exit codes: 0 = no warnings, 1 = warnings present.');
}
