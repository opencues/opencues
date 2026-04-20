// `opencues doctor` — cross-host diagnostics. Read-only inspection of
// install state across all integrations. Suggests fixes for what it
// finds wrong.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

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
  const userConfigDir = path.join(HOME, '.opencues');
  const projectConfigDir = path.join(process.cwd(), '.opencues');
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
  const ccRoot = path.join(HOME, '.claude/opencues');
  const ccCore = path.join(ccRoot, 'core');
  const ccRuntime = path.join(ccRoot, 'runtime');
  const ccBackup = path.join(ccRoot, 'patch-state/cli.js.backup');
  ok(`install root  ${ccRoot}/`, fs.existsSync(ccRoot));
  ok(`runtime`,    fs.existsSync(ccRuntime));
  ok(`core`,       fs.existsSync(ccCore));
  ok(`tweakcc backup`, fs.existsSync(ccBackup));
  // Detect cli.js patches.
  const cliCandidates = [
    path.join(HOME, '.claude/node_modules/@anthropic-ai/claude-code/cli.js'),
    path.join(HOME, 'claude-code-cues/node_modules/@anthropic-ai/claude-code/cli.js'),
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
  if (!fs.existsSync(ccRoot)) {
    findings.push({ sev: 'info', msg: 'CC not installed', fix: 'opencues install claude-code' });
  }
  console.log('');

  // ── OC install ────────────────────────────────────────────────────────
  console.log('## OpenCode (oc)');
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

  // ── Codex (Rust) ──────────────────────────────────────────────────────
  console.log('## OpenAI Codex (codex)');
  const codexFork = path.join(HOME, 'codex-cues');
  const codexBridge = path.join(codexFork, 'codex-rs/opencues-bridge');
  const codexLauncher = path.join(codexFork, 'run-codex-cues.sh');
  const codexDaemon = path.join(ctx.REPO_ROOT, 'packages/opencues-runtime/dist/adapters/codex/v1/daemon.js');
  const cargoCheck = spawnSync('cargo', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  ok(`cargo on PATH`, cargoCheck.status === 0);
  if (cargoCheck.status !== 0) {
    findings.push({ sev: 'info', msg: 'codex needs cargo (Rust toolchain)', fix: 'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh' });
  }
  if (fs.existsSync(codexFork)) {
    ok(`fork at ${codexFork}`, true);
    ok(`bridge crate`, fs.existsSync(codexBridge));
    ok(`launch helper`, fs.existsSync(codexLauncher));
  } else {
    bad(`fork at ${codexFork}`, false);
    findings.push({ sev: 'info', msg: 'Codex not installed', fix: 'opencues install codex (pre-alpha — see integrations/codex/HANDOFF.md)' });
  }
  ok(`daemon entry built`, fs.existsSync(codexDaemon));
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

  // ── Env / API keys ────────────────────────────────────────────────────
  console.log('## Environment');
  ok('GROQ_API_KEY (LLM)',         !!process.env.GROQ_API_KEY);
  ok('FINNHUB_API_KEY (stocks)',   !!process.env.FINNHUB_API_KEY);
  if (!process.env.GROQ_API_KEY) {
    findings.push({ sev: 'warn', msg: 'GROQ_API_KEY unset — LLM cues + blanks will be inert', fix: 'export GROQ_API_KEY=...' });
  }
  console.log('');

  // ── Runtime IPC files ─────────────────────────────────────────────────
  console.log('## Runtime IPC (created when CC/OC actually runs)');
  ok('/tmp/opencues.log',                       fs.existsSync('/tmp/opencues.log'));
  const cursorState = '/tmp/opencues-cursor-state.json';
  ok(cursorState,                                fs.existsSync(cursorState));
  console.log('');

  // ── Summary ───────────────────────────────────────────────────────────
  if (findings.length === 0) {
    console.log('OK — no issues found.');
    return;
  }
  console.log('## Suggested fixes');
  for (const f of findings) {
    const icon = f.sev === 'warn' ? '⚠' : 'ℹ';
    console.log(`  ${icon} ${f.msg}`);
    console.log(`    → ${f.fix}`);
  }
  const errors = findings.filter(f => f.sev === 'warn').length;
  if (errors > 0) process.exit(1);
};

function ok(label, present)  { console.log(`  ${present ? '✓' : '✗'}  ${label}`); }
function bad(label, present) { ok(label, present); }

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
