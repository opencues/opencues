// `opencues seed-configs` — host-agnostic. Manages the user-level
// ~/.opencues/ tree.
//
// Four responsibilities, all idempotent + safe to re-run:
//
//   1. SEED   first-time copy of repo defaults → ~/.opencues/
//             (cues.md, blanks.md, opencues.md, cues/, blanks/, scripts/)
//             Skips files that already exist with content (preserves user edits).
//
//   2. SYNC   library-script refresh on every run.
//             ~/.opencues/{blanks/<name>,scripts}/{*.sh,*.cs,*.ps1} ← repo defaults
//             These are LIBRARY code (not user content). They ship with the
//             repo, the user normally doesn't edit them, and stale copies
//             silently break things when paths change. Sync overwrites if
//             content differs from the repo source. .md files (user content)
//             are NEVER touched here.
//
//   3. HEAL   self-heal a 0-byte ~/.opencues/opencues.md.
//             OpenCuesSettingsBlank silently no-ops on empty content, so
//             an interrupted-write or pre-content seed would silently break
//             "opencues ___" / "config ___" blank-fills. Re-seed from defaults
//             when (file exists AND is 0 bytes AND repo source has content).
//
//   4. COMPILE  WSL only — compile colocated *.cs → *.exe in the same dir.
//               Helpers (BrightCtl.exe, VolCtl.exe, SpeakCtl.exe) live next
//               to the script that uses them via "${SCRIPT_DIR}/<helper>".
//
// Why this command (not the per-host installer) owns these:
//   ~/.opencues/ is shared across CC + OC. Putting these writes
//   inside CC's setup.sh meant OC users only got refreshes if
//   they happened to also install CC. That coupling is gone — every host
//   installer invokes seed-configs first, and standalone `opencues
//   seed-configs` does the same work.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// User-level seed targets. `.opencuesrc` lives at $HOME (outside the
// `.cues/` library). Library contents: words/ + blanks/ + scripts/.
// Project-level seeds the same library shape under <cwd>/.cues/ but
// no `.opencuesrc` (system settings are runtime-owned, user-level only).
const SEED_FILES_USER = ['cues', 'blanks', 'auditors', 'scripts'];
const SEED_FILES_PROJECT = ['cues', 'blanks', 'auditors'];

module.exports = function seedConfigs(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const dryRun = argv.includes('--dry-run');
  const projectScope = argv.includes('--project');
  const silent = argv.includes('--silent');
  const log = silent ? () => {} : console.log.bind(console);

  const HOME = os.homedir();
  const targetDir = projectScope
    ? path.join(process.cwd(), '.cues')
    : path.join(HOME, '.cues');
  const sourceDir = path.join(ctx.REPO_ROOT, 'defaults');
  // The runtime config (OPENCUES.md) lives at the top of the cues
  // library directory, alongside cues.md / blanks.md / auditors.md.
  const settingsTarget = projectScope
    ? null
    : (process.env.OPENCUES_HOME
        ? path.join(process.env.OPENCUES_HOME, 'OPENCUES.md')
        : path.join(HOME, '.cues', 'OPENCUES.md'));
  const settingsSource = path.join(sourceDir, 'OPENCUES.md');

  if (!fs.existsSync(sourceDir)) {
    console.error(`opencues seed-configs: source dir not found at ${sourceDir}`);
    console.error(`(this command must run from inside an opencues clone today)`);
    process.exit(1);
  }

  log(`Seeding ${projectScope ? 'project' : 'user'}-level configs:`);
  log(`  source: ${sourceDir}`);
  log(`  target: ${targetDir}`);
  log('');

  // ── 1. SEED — first-time copy ──────────────────────────────────────
  const seedFiles = projectScope ? SEED_FILES_PROJECT : SEED_FILES_USER;
  const plan = seedFiles.map(name => ({
    name,
    src: path.join(sourceDir, name),
    dst: path.join(targetDir, name),
    srcExists: fs.existsSync(path.join(sourceDir, name)),
    dstExists: hasContent(path.join(targetDir, name)),
  }));

  log('Seed plan (first-time copies):');
  for (const p of plan) {
    if (!p.srcExists) log(`  (no source) ${p.name}`);
    else if (p.dstExists) log(`  SKIP (exists) ${p.dst}`);
    else if (fs.existsSync(p.dst)) log(`  RESEED (empty) ${p.dst}`);
    else log(`  COPY ${p.src} → ${p.dst}`);
  }

  if (dryRun) { log('\n[dry-run] Nothing executed.'); return; }

  log('');
  fs.mkdirSync(targetDir, { recursive: true });
  let copied = 0, skipped = 0;
  for (const p of plan) {
    if (!p.srcExists || p.dstExists) { if (p.dstExists) skipped++; continue; }
    if (fs.statSync(p.src).isDirectory()) copyDir(p.src, p.dst);
    else { fs.mkdirSync(path.dirname(p.dst), { recursive: true }); fs.copyFileSync(p.src, p.dst); }
    copied++;
    log(`  copied ${p.name}`);
  }
  log(`Seeded ${copied}, skipped ${skipped}.`);

  // Seed `OPENCUES.md` separately — it's the system-settings file;
  // sits at the top of `~/.cues/` next to cues.md / blanks.md.
  if (settingsTarget && fs.existsSync(settingsSource)) {
    if (hasContent(settingsTarget)) {
      log(`  SKIP (exists) ${settingsTarget}`);
    } else {
      fs.mkdirSync(path.dirname(settingsTarget), { recursive: true });
      fs.copyFileSync(settingsSource, settingsTarget);
      log(`  copied ${path.basename(settingsTarget)}`);
    }
  }

  // If we skipped anything, surface the gotcha. SEED is first-time-only by
  // design (preserves user customisations), but that means new fields added
  // to shipped defaults DON'T flow into existing user files. Common bite:
  // opencues.md gets new opt-in flags (fluid-blank-mode, etc.)
  // and the user's existing opencues.md silently lacks them →
  // surfaces as "feature off" with no error.
  if (skipped > 0 && !silent) {
    log('');
    log('Note: existing files were preserved (your customisations stay).');
    log('If a recent update added new fields you want, options are:');
    log(`  - rm ${targetDir}/<file> && opencues seed-configs   (re-seed one file)`);
    log(`  - rm -rf ${targetDir} && opencues seed-configs       (full reset — loses customisations)`);
    log(`  - or merge new fields by hand from ${sourceDir}/<file>`);
  }

  // The remaining steps only apply to user-scope (project-scope is for
  // overrides, not library/utility files which stay user-level).
  if (projectScope) return;

  // ── 1.5 ADDITIVE SEED — copy in any NEW subdirs (blanks/<name>,
  // words/<name>) that exist in defaults/ but not yet in ~/.cues/.
  // The original SEED phase only copies the top-level `blanks/` dir
  // once; new shipped blanks (or words) added in a later release would
  // otherwise be silently missed. .md inside copied subdirs is user
  // content from then on (SYNC won't touch it). ──────────────────────
  log('');
  log('Additive seed (new entries from defaults/{words,blanks}/):');
  let added = 0;
  for (const parent of ['words', 'blanks']) {
    const srcParent = path.join(sourceDir, parent);
    const dstParent = path.join(targetDir, parent);
    if (!fs.existsSync(srcParent)) continue;
    fs.mkdirSync(dstParent, { recursive: true });
    for (const entry of fs.readdirSync(srcParent, { withFileTypes: true })) {
      const subSrc = path.join(srcParent, entry.name);
      const subDst = path.join(dstParent, entry.name);
      if (fs.existsSync(subDst)) continue; // user already has it (or opted out)
      if (!entry.isDirectory()) continue;
      copyDir(subSrc, subDst);
      added++;
      log(`  added ${parent}/${entry.name}/`);
    }
  }
  if (added === 0) log('  (no new entries)');

  // ── 2. SYNC — library files (always overwrite if differs) ──────────
  log('');
  log('Library sync (.sh/.cs/.ps1 from defaults — never overwrites .md):');
  let synced = 0;

  // 2a. defaults/blanks/<name>/ → ~/.cues/blanks/<name>/
  for (const ctlDir of listChildDirs(path.join(sourceDir, 'blanks'))) {
    const ctl = path.basename(ctlDir);
    const userDir = path.join(targetDir, 'blanks', ctl);
    if (!fs.existsSync(userDir)) continue; // not seeded → user opted out
    for (const src of listFilesByExt(ctlDir, ['.sh', '.cs', '.ps1'])) {
      const dst = path.join(userDir, path.basename(src));
      if (syncIfDiffers(src, dst)) { synced++; log(`  synced ${dst}`); }
    }
  }

  // 2b. defaults/scripts/ → ~/.cues/scripts/
  const scriptsSrc = path.join(sourceDir, 'scripts');
  const scriptsDst = path.join(targetDir, 'scripts');
  if (fs.existsSync(scriptsSrc)) {
    fs.mkdirSync(scriptsDst, { recursive: true });
    for (const src of listFilesByExt(scriptsSrc, ['.sh', '.cs', '.ps1'])) {
      const dst = path.join(scriptsDst, path.basename(src));
      if (syncIfDiffers(src, dst)) { synced++; log(`  synced ${dst}`); }
    }
  }

  if (synced === 0) log('  (no changes — library files current)');

  // ── 3. HEAL — self-heal empty OPENCUES.md + rename legacy cue.md → blank.md ──
  log('');
  if (settingsTarget && hasContent(settingsSource)) {
    if (fs.existsSync(settingsTarget) && fs.statSync(settingsTarget).size === 0) {
      fs.copyFileSync(settingsSource, settingsTarget);
      log(`Self-heal: reseeded empty ${settingsTarget} from defaults`);
    }
  }

  // Migrate legacy `<userDir>/blanks/<name>/{cue.md,blank.md}` → `BLANK.md`
  // per the open standard (spec/blank-spec.md). Idempotent: if BLANK.md
  // already exists, skip the source; otherwise rename whichever legacy
  // form exists. Two legacy names are recognised because the standard
  // moved cue.md → blank.md → BLANK.md across two minor revisions.
  const userBlanksDir = path.join(targetDir, 'blanks');
  if (fs.existsSync(userBlanksDir)) {
    let renamed = 0;
    for (const subDir of listChildDirs(userBlanksDir)) {
      const targetPath = path.join(subDir, 'BLANK.md');
      if (fs.existsSync(targetPath)) continue;
      for (const legacyName of ['blank.md', 'cue.md']) {
        const legacyPath = path.join(subDir, legacyName);
        if (fs.existsSync(legacyPath)) {
          fs.renameSync(legacyPath, targetPath);
          renamed++;
          log(`  migrated ${path.basename(subDir)}/${legacyName} → BLANK.md`);
          break;
        }
      }
    }
    if (renamed > 0) log(`Self-heal: renamed ${renamed} legacy blank file → BLANK.md`);
  }

  // ── 4. COMPILE — colocated .cs → .exe (WSL only) ───────────────────
  const csc = '/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
  if (fs.existsSync(csc)) {
    log('');
    log('Compile (.cs → .exe, WSL):');
    let compiled = 0;
    // 4a. blanks/<name>/*.cs colocated.
    for (const userDir of listChildDirs(path.join(targetDir, 'blanks'))) {
      for (const csFile of listFilesByExt(userDir, ['.cs'])) {
        if (compileExe(csc, csFile, userDir, log)) compiled++;
      }
    }
    // 4b. scripts/*.cs colocated.
    if (fs.existsSync(scriptsDst)) {
      for (const csFile of listFilesByExt(scriptsDst, ['.cs'])) {
        if (compileExe(csc, csFile, scriptsDst, log)) compiled++;
      }
    }
    if (compiled === 0) log('  (no changes — all .exe artifacts current)');
  }

  log('');
  log('Edit any seeded .md to change defaults; hot-reload picks up on the next keystroke.');
  if (!silent) {
    log('For project-specific overrides: `opencues seed-configs --project` from a project dir.');
  }
};

// ─── helpers ───────────────────────────────────────────────────────────

/** A path is "present with content" if it's a non-empty file or any directory.
 *  0-byte files count as missing — the runtime parses them as "no config" and
 *  silently no-ops, e.g. an empty opencues.md hides "opencues ___" blank-fills. */
function hasContent(p) {
  if (!fs.existsSync(p)) return false;
  const st = fs.statSync(p);
  return st.isDirectory() || st.size > 0;
}

function listChildDirs(parent) {
  if (!fs.existsSync(parent)) return [];
  return fs.readdirSync(parent, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(parent, d.name));
}

function listFilesByExt(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile())
    .filter(d => exts.includes(path.extname(d.name)))
    .map(d => path.join(dir, d.name));
}

/** cmp src + dst; copy if different. Returns true when a copy happened. */
function syncIfDiffers(src, dst) {
  if (fs.existsSync(dst)) {
    try {
      if (fs.readFileSync(src).equals(fs.readFileSync(dst))) return false;
    } catch { /* fall through to copy */ }
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  if (path.extname(dst) === '.sh') fs.chmodSync(dst, 0o755);
  return true;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Compile .cs → .exe colocated (same dir as .cs). Returns true if compiled.
 *  Skip when .exe is already newer than .cs. SpeakCtl.cs needs WPF reference. */
function compileExe(csc, csFile, outDir, log) {
  const base = path.basename(csFile, '.cs');
  const exe = path.join(outDir, `${base}.exe`);
  if (fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= fs.statSync(csFile).mtimeMs) {
    return false;
  }
  // csc.exe runs on Windows — needs Windows-style paths in C:\Users\<user>\.
  // Stage the .cs file in the Windows TEMP dir so paths are addressable.
  let winUser;
  try {
    winUser = spawnSync('cmd.exe', ['/c', 'echo %USERNAME%'], { encoding: 'utf8' })
      .stdout.trim().replace(/\r/g, '');
  } catch { return false; }
  if (!winUser) return false;
  const winTmp = `/mnt/c/Users/${winUser}`;
  const stagedCs = path.join(winTmp, `${base}.cs`);
  const stagedExe = path.join(winTmp, `${base}.exe`);
  try {
    fs.copyFileSync(csFile, stagedCs);
    const args = ['/nologo', '/optimize'];
    if (base === 'SpeakCtl') {
      args.push('/reference:C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\WPF\\System.Speech.dll');
    }
    args.push(`/out:C:\\Users\\${winUser}\\${base}.exe`, `C:\\Users\\${winUser}\\${base}.cs`);
    const r = spawnSync(csc, args, { stdio: 'pipe' });
    if (r.status === 0 && fs.existsSync(stagedExe)) {
      fs.copyFileSync(stagedExe, exe);
      log(`  compiled ${exe}`);
      return true;
    }
  } finally {
    try { fs.unlinkSync(stagedCs); } catch {}
    try { fs.unlinkSync(stagedExe); } catch {}
  }
  return false;
}
function printHelp() {
  console.log('opencues seed-configs [--project] [--dry-run] [--silent]');
  console.log('');
  console.log('Manage the user-level ~/.opencues/ tree. Idempotent + safe to re-run.');
  console.log('');
  console.log('On every invocation:');
  console.log('  1. Seed first-time copies (cues.md, blanks.md, etc.) — never overwrites');
  console.log('  2. Sync library files (.sh/.cs/.ps1) from defaults/{blanks,scripts}/');
  console.log('     — overwrites stale copies but never .md (user content)');
  console.log('  3. Self-heal a 0-byte opencues.md (would otherwise silently break');
  console.log('     "opencues ___" / "config ___" blank-fills on native hosts)');
  console.log('  4. Compile colocated .cs → .exe (WSL only — needs csc.exe)');
  console.log('');
  console.log('  --project    Seed <cwd>/.opencues/ instead of ~/.opencues/');
  console.log('               (sync/self-heal/compile only run for user scope)');
  console.log('  --dry-run    Print the plan; do not copy or compile anything');
  console.log('  --silent     Suppress non-error output (used when chained from install)');
  console.log('  --help       Show this message');
}
