// `opencues seed-configs` — host-agnostic. Copies <repo>/.opencues/
// defaults into ~/.opencues/. Idempotent (skips files that exist).
//
// This is its own implementation rather than a shell-out because it's
// not tied to any specific host integration — it's a workspace-level
// operation. The per-host installers each have a `seed-configs`
// subcommand too; this is the unified entry point users discover via
// `opencues --help`.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SEED_FILES = ['cues.md', 'blanks.md', 'controls.md', 'opencues.md', 'cues', 'controls'];

module.exports = function seedConfigs(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const dryRun = argv.includes('--dry-run');
  const projectScope = argv.includes('--project');

  const HOME = os.homedir();
  const targetDir = projectScope
    ? path.join(process.cwd(), '.opencues')
    : path.join(HOME, '.opencues');
  const sourceDir = path.join(ctx.REPO_ROOT, '.opencues');

  if (!fs.existsSync(sourceDir)) {
    console.error(`opencues seed-configs: source dir not found at ${sourceDir}`);
    console.error(`(this command must run from inside an opencues clone today)`);
    process.exit(1);
  }

  console.log(`Seeding ${projectScope ? 'project' : 'user'}-level configs:`);
  console.log(`  source: ${sourceDir}`);
  console.log(`  target: ${targetDir}`);
  console.log('');

  const plan = SEED_FILES.map(name => ({
    name,
    src: path.join(sourceDir, name),
    dst: path.join(targetDir, name),
    srcExists: fs.existsSync(path.join(sourceDir, name)),
    dstExists: fs.existsSync(path.join(targetDir, name)),
  }));

  console.log('Plan:');
  for (const p of plan) {
    if (!p.srcExists) console.log(`  (no source) ${p.name}`);
    else if (p.dstExists) console.log(`  SKIP (exists) ${p.dst}`);
    else console.log(`  COPY ${p.src} → ${p.dst}`);
  }

  if (dryRun) { console.log('\n[dry-run] Nothing executed.'); return; }

  console.log('');
  fs.mkdirSync(targetDir, { recursive: true });
  let copied = 0, skipped = 0;
  for (const p of plan) {
    if (!p.srcExists || p.dstExists) { if (p.dstExists) skipped++; continue; }
    if (fs.statSync(p.src).isDirectory()) copyDir(p.src, p.dst);
    else { fs.mkdirSync(path.dirname(p.dst), { recursive: true }); fs.copyFileSync(p.src, p.dst); }
    copied++;
    console.log(`  copied ${p.name}`);
  }
  console.log(`\nSeeded ${copied} configs, skipped ${skipped} (already present).`);
  console.log('Edit any of these to change defaults; hot-reload picks up on the next keystroke.');
  if (!projectScope) {
    console.log('For project-specific overrides: `opencues seed-configs --project` from a project dir.');
  }
};

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function printHelp() {
  console.log('opencues seed-configs [--project] [--dry-run]');
  console.log('');
  console.log('Copy the repo\'s default configs into ~/.opencues/ (or <cwd>/.opencues/ with');
  console.log('--project). Skips any file that already exists at the destination.');
  console.log('');
  console.log('  --project    Seed <cwd>/.opencues/ instead of ~/.opencues/');
  console.log('  --dry-run    Print the plan; do not copy anything');
  console.log('  --help       Show this message');
}
