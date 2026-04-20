// `opencues update` — pull latest, rebuild, redeploy installed integrations.
//
// Effectively a one-shot: git pull → pnpm install → pnpm build → re-run
// each integration's installer that's currently active.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

module.exports = function update(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const dryRun = argv.includes('--dry-run');
  const skipPull = argv.includes('--no-pull');

  const HOME = os.homedir();
  const installed = detectInstalled(HOME, ctx.REPO_ROOT);

  console.log('opencues update — pull, build, redeploy\n');
  console.log('Detected installs:');
  for (const i of installed) console.log(`  ${i.host}  (${i.evidence})`);
  if (installed.length === 0) console.log('  (none — nothing to redeploy)');
  console.log('');

  const steps = [];
  if (!skipPull) steps.push({ desc: 'git pull', argv: ['git', 'pull'], cwd: ctx.REPO_ROOT });
  steps.push({ desc: 'pnpm install', argv: ['pnpm', 'install'], cwd: ctx.REPO_ROOT });
  steps.push({ desc: 'pnpm build',   argv: ['pnpm', 'build'],   cwd: ctx.REPO_ROOT });
  for (const i of installed) {
    steps.push({ desc: `redeploy ${i.host}`, argv: ['node', path.join(ctx.REPO_ROOT, 'integrations', i.folder, 'bin/install.cjs'), 'install'], cwd: ctx.REPO_ROOT });
  }

  console.log('Plan:');
  for (const s of steps) console.log(`  ${s.argv.join(' ')}  (cwd ${s.cwd})`);
  if (dryRun) { console.log('\n[dry-run] Nothing executed.'); return; }
  console.log('');

  for (const s of steps) {
    console.log(`▶ ${s.desc}`);
    const r = spawnSync(s.argv[0], s.argv.slice(1), { cwd: s.cwd, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`\nSTOPPED: "${s.desc}" exited ${r.status}.`);
      process.exit(r.status ?? 1);
    }
    console.log('');
  }
  console.log('Update complete.');
};

function detectInstalled(HOME, REPO_ROOT) {
  const out = [];
  if (fs.existsSync(path.join(HOME, '.claude/opencues/runtime'))) {
    out.push({ host: 'claude-code', folder: 'cc', evidence: '~/.claude/opencues/runtime exists' });
  }
  const ocFork = path.join(HOME, 'opencode-cues');
  if (fs.existsSync(path.join(ocFork, 'node_modules/@opencues/runtime'))) {
    out.push({ host: 'opencode',    folder: 'oc', evidence: `${ocFork}/node_modules/@opencues/runtime exists` });
  }
  if (fs.existsSync(path.join(REPO_ROOT, 'integrations/chrome/dist/content.js'))) {
    out.push({ host: 'chrome', folder: 'chrome', evidence: 'integrations/chrome/dist/content.js exists' });
  }
  return out;
}

function printHelp() {
  console.log('opencues update [--no-pull] [--dry-run]');
  console.log('');
  console.log('Pull latest, install deps, rebuild packages, and redeploy every');
  console.log('integration that\'s currently installed (detected by checking install');
  console.log('artefacts on disk).');
  console.log('');
  console.log('  --no-pull    Skip `git pull` (use current local code)');
  console.log('  --dry-run    Print plan, do not execute');
  console.log('');
  console.log('Stops at the first failure. After this finishes, restart your editor');
  console.log('integrations (claude-cues, the OC fork, reload chrome extension).');
}
