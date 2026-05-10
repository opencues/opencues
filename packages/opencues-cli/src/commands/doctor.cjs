// `opencues doctor` — cross-host diagnostics. Read-only inspection of
// install state across all integrations. Suggests fixes for what it
// finds wrong.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const compatLib = require('../lib/compat.cjs');

module.exports = function doctor(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  const HOME = os.homedir();
  const findings = [];

  console.log('opencues doctor — cross-host install diagnostics\n');

  // ── Workspace ─────────────────────────────────────────────────────────
  console.log('## Workspace');
  const wsDir = ctx.REPO_ROOT;
  const wsLockfile = path.join(wsDir, 'pnpm-lock.yaml');
  const wsBuilt = path.join(wsDir, 'packages/opencues-runtime/dist/src/index.js');
  ok(`opencues clone at ${wsDir}`, fs.existsSync(wsDir));
  ok(`pnpm-lock.yaml present`, fs.existsSync(wsLockfile));
  if (!fs.existsSync(wsBuilt)) {
    findings.push({ sev: 'warn', msg: '@opencues/runtime not built', fix: 'pnpm build' });
    bad(`@opencues/runtime built (${wsBuilt})`, false);
  } else {
    ok(`@opencues/runtime built`, true);
  }
  console.log('');

  // ── Configs ───────────────────────────────────────────────────────────
  console.log('## Configs');
  const userConfigDir = path.join(HOME, '.cues');
  const projectConfigDir = path.join(process.cwd(), '.cues');
  ok(`user-level    ${userConfigDir}/`, fs.existsSync(userConfigDir));
  ok(`project-level ${projectConfigDir}/`, fs.existsSync(projectConfigDir));
  if (process.env.OPENCUES_HOME) {
    ok(`$OPENCUES_HOME → ${process.env.OPENCUES_HOME}/`, fs.existsSync(process.env.OPENCUES_HOME));
  }
  if (!fs.existsSync(userConfigDir)) {
    findings.push({ sev: 'info', msg: 'no user-level configs', fix: 'opencues seed-configs' });
  }
  console.log('');

  // ── CC install ────────────────────────────────────────────────────────
  console.log('## Claude Code (cc)');
  reportPinStatus('claude-code', ctx, HOME, findings);
  // Compact-footprint layout: everything inside <CC_FORK>/{node_modules/@opencues, .opencues}.
  // Auto-detect the fork dir; ~/claude-code-cues is the default install location.
  const ccFork = path.join(HOME, 'claude-code-cues');
  const ccSupport = path.join(ccFork, '.opencues');
  const ccCore = path.join(ccFork, 'node_modules/@opencues/core');
  const ccRuntime = path.join(ccFork, 'node_modules/@opencues/runtime');
  const ccBackup = path.join(ccSupport, 'patch-state/cli.js.backup');
  ok(`fork dir     ${ccFork}/`, fs.existsSync(ccFork));
  ok(`support dir  ${ccSupport}/`, fs.existsSync(ccSupport));
  ok(`runtime`,    fs.existsSync(ccRuntime));
  ok(`core`,       fs.existsSync(ccCore));
  ok(`tweakcc backup`, fs.existsSync(ccBackup));
  // Warn if a stale pre-compact-footprint install is still on disk.
  const legacyCcRoot = path.join(HOME, '.claude/opencues');
  if (fs.existsSync(legacyCcRoot)) {
    findings.push({
      sev: 'warn',
      msg: `legacy install at ${legacyCcRoot}/ — re-run install to migrate to compact footprint`,
      fix: 'opencues install claude-code',
    });
  }
  // Detect cli.js patches.
  const cliCandidates = [
    path.join(HOME, '.claude/node_modules/@anthropic-ai/claude-code/cli.js'),
    path.join(ccFork, 'node_modules/@anthropic-ai/claude-code/cli.js'),
  ];
  for (const cli of cliCandidates) {
    if (!fs.existsSync(cli)) continue;
    const content = fs.readFileSync(cli, 'utf8');
    const patched = content.includes('@opencues/runtime');
    ok(`${cli} → patched`, patched);
    if (!patched) {
      findings.push({ sev: 'warn', msg: `cli.js at ${cli} is not patched`, fix: `opencues install claude-code --target ${cli}` });
    }
  }
  if (!fs.existsSync(ccSupport)) {
    findings.push({ sev: 'info', msg: 'CC not installed (compact footprint)', fix: 'opencues install claude-code' });
  }
  console.log('');

  // ── OC install ────────────────────────────────────────────────────────
  console.log('## OpenCode (oc)');
  reportPinStatus('opencode', ctx, HOME, findings);
  const ocFork = path.join(HOME, 'opencode-cues');
  if (fs.existsSync(ocFork)) {
    ok(`fork at ${ocFork}`, true);
    ok(`fork/node_modules/@opencues/runtime`, fs.existsSync(path.join(ocFork, 'node_modules/@opencues/runtime')));
    ok(`fork/node_modules/@opencues/core`,    fs.existsSync(path.join(ocFork, 'node_modules/@opencues/core')));
    const opencuesTs = path.join(ocFork, 'packages/opencode/src/cli/cmd/tui/opencues.ts');
    ok(`bootstrap copy in fork`, fs.existsSync(opencuesTs));
  } else {
    bad(`fork at ${ocFork}`, false);
    findings.push({ sev: 'info', msg: 'OC fork not present', fix: 'opencues install opencode' });
  }
  console.log('');

  // ── Chrome ────────────────────────────────────────────────────────────
  console.log('## Chrome');
  const chromeDist = path.join(ctx.REPO_ROOT, 'integrations/chrome/dist');
  const chromeContentJs = path.join(chromeDist, 'content.js');
  ok(`build output ${chromeDist}/`, fs.existsSync(chromeDist));
  ok(`content.js`, fs.existsSync(chromeContentJs));
  if (!fs.existsSync(chromeContentJs)) {
    findings.push({ sev: 'info', msg: 'Chrome extension not built', fix: 'opencues install chrome' });
  }
  console.log('');

  // ── Gemini CLI install ────────────────────────────────────────────────
  console.log('## Gemini CLI');
  reportPinStatus('gemini-cli', ctx, HOME, findings);
  const geminiFork = path.join(HOME, 'gemini-cli-cues');
  if (fs.existsSync(geminiFork)) {
    ok(`fork at ${geminiFork}`, true);
    ok(`fork/node_modules/@opencues/runtime`, fs.existsSync(path.join(geminiFork, 'node_modules/@opencues/runtime')));
    ok(`fork/node_modules/@opencues/core`,    fs.existsSync(path.join(geminiFork, 'node_modules/@opencues/core')));
    const geminiBootstrap = path.join(geminiFork, 'packages/cli/src/ui/opencues.ts');
    ok(`bootstrap copy in fork`, fs.existsSync(geminiBootstrap));
    const geminiBuilt = path.join(geminiFork, 'packages/cli/dist/index.js');
    ok(`built CLI`, fs.existsSync(geminiBuilt));
  } else {
    bad(`fork at ${geminiFork}`, false);
    findings.push({ sev: 'info', msg: 'Gemini CLI fork not present', fix: 'opencues install gemini-cli' });
  }
  console.log('');

  // ── Env / API keys ────────────────────────────────────────────────────
  console.log('## Environment');
  ok('GROQ_API_KEY (LLM)',         !!process.env.GROQ_API_KEY);
  ok('FINNHUB_API_KEY (stocks)',   !!process.env.FINNHUB_API_KEY);
  if (!process.env.GROQ_API_KEY) {
    findings.push({ sev: 'warn', msg: 'GROQ_API_KEY unset — LLM cues + blanks will be inert', fix: 'export GROQ_API_KEY=...' });
  }
  console.log('');

  // ── Runtime IPC files ─────────────────────────────────────────────────
  console.log('## Runtime IPC (created when CC/OC/Gemini actually runs)');
  ok('/tmp/opencues.log',                       fs.existsSync('/tmp/opencues.log'));
  const cursorState = '/tmp/opencues-cursor-state.json';
  ok(cursorState,                                fs.existsSync(cursorState));
  console.log('');

  // ── Summary ───────────────────────────────────────────────────────────
  if (findings.length === 0) {
    console.log('OK — no issues found.');
    return 0;
  }
  console.log('## Suggested fixes');
  for (const f of findings) {
    const icon = f.sev === 'warn' ? '⚠' : 'ℹ';
    console.log(`  ${icon} ${f.msg}`);
    console.log(`    → ${f.fix}`);
  }
  const errors = findings.filter(f => f.sev === 'warn').length;
  // Return the exit code instead of calling process.exit from a library
  // function. The CLI entry point (bin/cli.cjs) honours numeric return
  // values; tests can inspect the return value without process.exit
  // killing the runtime mid-assertion.
  return errors > 0 ? 1 : 0;
};

function ok(label, present)  { console.log(`  ${present ? '✓' : '✗'}  ${label}`); }
function bad(label, present) { ok(label, present); }

/**
 * Print a one-line pin-status check for the given integration.
 * Reads compat.json + the local pin (no network — that's `update --check`).
 * Surfaces drift: pin is tested ✓ / pin is in compat-range but untested ⚠ /
 * pin is incompatible (shouldn't happen because installer should refuse,
 * but check anyway).
 */
function reportPinStatus(host, ctx, HOME, findings) {
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
      ok(`pin status   ${pin} (tested, but ${latestTested} is newer-tested)`, true);
    } else {
      ok(`pin status   ${pin} (tested ✓)`, true);
    }
  } else if (cls.status === 'compat-untested') {
    bad(`pin status   ${pin} (in compat-range ${compat['compat-range']}, NOT tested)`, false);
    findings.push({
      sev: 'info',
      msg: `${host}: pin ${pin} is in compat-range but not in maintainer's tested list`,
      fix: latestTested ? `opencues update ${host} --to ${latestTested}  (or test + add to compat.json)` : `add ${pin} to integrations/${host}/compat.json's "tested" list once verified`,
    });
  } else if (cls.status === 'incompatible') {
    bad(`pin status   ${pin} (KNOWN INCOMPATIBLE: ${cls.reason})`, false);
    findings.push({
      sev: 'warn',
      msg: `${host}: pin ${pin} is known-incompatible (${cls.reason})`,
      fix: latestTested ? `opencues update ${host} --to ${latestTested}` : `pick a tested version + opencues update ${host} --to <v>`,
    });
  } else if (cls.status === 'out-of-range') {
    bad(`pin status   ${pin} (OUT OF compat-range ${compat['compat-range']})`, false);
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
