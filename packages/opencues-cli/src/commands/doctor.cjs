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
  // Surface optional-feature state at the install boundary. Each row
  // pairs a scalar in OPENCUES.md with its prerequisites; when the
  // scalar is on but a prerequisite is missing, the feature is silently
  // inert. This is the exact failure class we hit during the
  // user-context + ambient-context ship — USER.md absent + scalar set
  // → no log, no error, the LLM just gets no catalog.
  {
    const s = section('Feature wiring', 'optional features + their prerequisites');
    const opencuesMd = path.join(userConfigDir, 'CUES.md');
    const userMd = path.join(userConfigDir, 'USER.md');
    const auditorsMd = path.join(userConfigDir, 'AUDITORS.md');
    const scalars = readOpencuesScalars(opencuesMd);
    const userFieldCount = countUserMdFields(userMd);
    const auditorCount = countAuditorEntries(auditorsMd);

    const fmtScalar = (key, def = 'off') => scalars[key] != null ? scalars[key] : dim(`(${def})`);
    s.info('user-context-mode',    fmtScalar('user-context-mode'));
    s.info('ambient-context-mode', fmtScalar('ambient-context-mode'));
    s.info('fluid-blank-mode',     fmtScalar('fluid-blank-mode', 'on'));
    s.info('voice-mode',           fmtScalar('voice-mode'));
    s.info('tips-mode',            fmtScalar('tips-mode', 'on'));
    s.info('debug-mode',           fmtScalar('debug-mode'));
    s.info('cursor-navigate',      fmtScalar('cursor-navigate'));
    s.info('word-cues-mode',       fmtScalar('word-cues-mode', 'on'));
    s.ok(`USER.md present (${userFieldCount} field${userFieldCount === 1 ? '' : 's'})`, fs.existsSync(userMd));
    s.ok(`AUDITORS.md present (${auditorCount} auditor${auditorCount === 1 ? '' : 's'})`, fs.existsSync(auditorsMd));
    s.render();

    // user-context-mode is set, but USER.md missing or empty → feature won't fire
    if (scalars['user-context-mode'] && scalars['user-context-mode'] !== 'off' && userFieldCount === 0) {
      findings.push({
        sev: 'warn',
        msg: `user-context-mode=${scalars['user-context-mode']} but USER.md is missing or has no populated fields — fluid-blank won't get any user catalog`,
        fix: fs.existsSync(userMd)
          ? `populate ${userMd} frontmatter with at least one field (e.g. firstName: Alice)`
          : `opencues seed-configs   # creates USER.md template; then edit ${userMd}`,
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
        const required = ['OPENCUES.md', 'CUES.md', 'AUDITORS.md', 'USER.md'];
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
  {
    const s = section('Environment', 'API keys exported in this shell session');
    // Every supported provider — matches the set check-keys probes + the
    // chrome host's host-pushed API key list. Each is independent:
    // unsetting one disables only that provider, not the runtime overall.
    s.ok('GROQ_API_KEY (LLM — default)',     !!process.env.GROQ_API_KEY);
    s.ok('CEREBRAS_API_KEY (LLM)',           !!process.env.CEREBRAS_API_KEY);
    s.ok('OPENAI_API_KEY (LLM)',             !!process.env.OPENAI_API_KEY);
    s.ok('ANTHROPIC_API_KEY (LLM)',          !!process.env.ANTHROPIC_API_KEY);
    s.ok('OPENROUTER_API_KEY (LLM)',         !!process.env.OPENROUTER_API_KEY);
    s.ok('GEMINI_API_KEY (LLM)',             !!process.env.GEMINI_API_KEY);
    s.ok('FINNHUB_API_KEY (stocks blank)',   !!process.env.FINNHUB_API_KEY);
    s.render();
  }
  // GROQ is the shipped default — flag if it's missing AND no other LLM
  // provider key is set (any one of them lets the runtime cover LLM-driven
  // surfaces via per-cue / global tier overrides).
  const hasAnyLlmKey = !!(process.env.GROQ_API_KEY || process.env.CEREBRAS_API_KEY
    || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY
    || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY);
  if (!hasAnyLlmKey) {
    findings.push({ sev: 'warn', msg: 'no LLM provider key set — every LLM-driven cue/blank will be inert', fix: 'export GROQ_API_KEY=... (or another supported provider)' });
  } else if (!process.env.GROQ_API_KEY) {
    findings.push({ sev: 'info', msg: 'GROQ_API_KEY unset — non-default provider configured; ensure your CUES.md / OPENCUES.md sets `llm-provider:` to a host you have a key for', fix: 'opencues check-keys' });
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

// Count non-comment populated frontmatter fields in USER.md.
function countUserMdFields(file) {
  if (!file || !fs.existsSync(file)) return 0;
  return Object.keys(readOpencuesScalars(file)).length;
}

// Count `### name` entries (auditor blocks) in AUDITORS.md.
function countAuditorEntries(file) {
  if (!file || !fs.existsSync(file)) return 0;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const matches = text.match(/^###\s+\S/gm);
    return matches ? matches.length : 0;
  } catch { return 0; }
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
