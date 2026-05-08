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
const SEED_FILES_USER = ['cues', 'blanks', 'scripts'];
const SEED_FILES_PROJECT = ['cues', 'blanks'];

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
  // (The old layout had `.opencuesrc` at $HOME root; that's migrated
  // into $HOME/.cues/OPENCUES.md by the migration step below.)
  const settingsTarget = projectScope
    ? null
    : (process.env.OPENCUES_HOME
        ? path.join(process.env.OPENCUES_HOME, 'OPENCUES.md')
        : path.join(HOME, '.cues', 'OPENCUES.md'));
  const settingsSource = path.join(sourceDir, 'OPENCUES.md');
  // Legacy paths used by the migration step.
  const legacySettingsTarget = projectScope
    ? null
    : (process.env.OPENCUES_HOME
        ? path.join(process.env.OPENCUES_HOME, 'opencuesrc')
        : path.join(HOME, '.opencuesrc'));

  if (!fs.existsSync(sourceDir)) {
    console.error(`opencues seed-configs: source dir not found at ${sourceDir}`);
    console.error(`(this command must run from inside an opencues clone today)`);
    process.exit(1);
  }

  log(`Seeding ${projectScope ? 'project' : 'user'}-level configs:`);
  log(`  source: ${sourceDir}`);
  log(`  target: ${targetDir}`);
  log('');

  // ── 0. MIGRATE — old layout (~/.opencues/ with cues/ + blanks/) →
  // OpenStandard layout (~/.cues/ with words/ + blanks/, ~/.opencuesrc
  // at $HOME). Idempotent: re-running after migration is a no-op
  // (signals are gone). User-scope only.
  if (!projectScope && !dryRun) {
    migrateOpenStandardLayout(HOME, settingsTarget, targetDir, log);
    // ── 0b. MIGRATE — `.opencuesrc` at $HOME → $HOME/.cues/OPENCUES.md
    // Settings file moved into the cues dir to sit alongside cues.md /
    // blanks.md / auditors.md, and renamed/reformatted to a markdown
    // file with frontmatter. Idempotent: skips when the target exists.
    migrateOpencuesRcToOpencuesMd(legacySettingsTarget, settingsTarget, log);
    // ── 0c. MIGRATE — `~/.cues/words/` → `~/.cues/cues/`. Restored
    // symmetry with `cues.md` after the brief words/ era. Idempotent:
    // merges file-by-file when both paths exist; cues/ wins on
    // conflicts (it's the post-rename canonical location).
    migrateWordsToCues(targetDir, log);
  }

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
      if (entry.isDirectory()) copyDir(subSrc, subDst);
      else if (entry.isFile() && entry.name.endsWith('.md')) fs.copyFileSync(subSrc, subDst);
      else continue;
      added++;
      log(`  added ${parent}/${entry.name}${entry.isDirectory() ? '/' : ''}`);
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

// ─── Migration: pre-OpenStandard → OpenStandard layout ─────────────────────
//
// Walks the user from any prior layout to the current OpenStandard:
//
//   ~/.opencuesrc          (system settings — was inside cues.md frontmatter
//                           or in an opencues.md sibling)
//   ~/.cues/words/         (was: ~/.opencues/cues/, with one folder per source)
//   ~/.cues/blanks/        (was: ~/.opencues/blanks/)
//   ~/.cues/scripts/       (was: ~/.opencues/scripts/)
//
// Idempotent. Three stages, applied in order:
//   1. Inner-content migration on the OLD `~/.opencues/` (extract settings
//      from cues.md frontmatter, split ## Tips into folders, etc.) — this
//      is the previous unification arc, kept here for users still on the
//      pre-unification shape.
//   2. Move ~/.opencues/ → ~/.cues/, extract settings to ~/.opencuesrc.
//   3. Rename inner cues/ → words/, flatten single-file folders.
function migrateOpenStandardLayout(HOME, settingsTarget, newCuesDir, log) {
  const oldDir = path.join(HOME, '.opencues');
  const hasOldDir = fs.existsSync(oldDir);
  // Quick exit: nothing to migrate.
  if (!hasOldDir) return;

  log('Migrating ~/.opencues/ → ~/.cues/ + ~/.opencuesrc:');

  // Stage 1 — pre-unification migration (still applies to users who
  // skipped the previous arc).
  migrateLegacyContents(oldDir, log);

  // Stage 2 — extract cues.md frontmatter into .opencuesrc, then move
  // the dir over to .cues/.
  const oldCuesMd = path.join(oldDir, 'cues.md');
  if (settingsTarget && fs.existsSync(oldCuesMd) && !fs.existsSync(settingsTarget)) {
    const cuesContent = fs.readFileSync(oldCuesMd, 'utf8');
    const fmMatch = cuesContent.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      // Drop project-metadata fields (name/domain/version/ignore — those
      // belong to project cues.md, not the runtime config file).
      const settingsYaml = fmMatch[1].split('\n')
        .filter(line => {
          const m = line.match(/^([A-Za-z][A-Za-z0-9_\- ]*?):/);
          if (!m) return true;
          return !['name', 'domain', 'version', 'ignore'].includes(m[1]);
        }).join('\n');
      fs.mkdirSync(path.dirname(settingsTarget), { recursive: true });
      // settingsTarget is now ~/.cues/OPENCUES.md (markdown with
      // frontmatter). Wrap the extracted YAML in `---` fences and add
      // a brief body — matches the format of `defaults/OPENCUES.md`.
      const yaml = settingsYaml.replace(/^\s+/, '').replace(/\n+$/, '');
      fs.writeFileSync(
        settingsTarget,
        `---\n${yaml}\n---\n\n` +
        `# OPENCUES.md — Runtime Configuration\n\n` +
        `Migrated from a legacy \`cues.md\` frontmatter. See\n` +
        `\`defaults/OPENCUES.md\` for the full annotated example.\n`,
      );
      log(`  wrote ${settingsTarget}`);
    }
    fs.unlinkSync(oldCuesMd);
  }

  // Stage 3 — move ~/.opencues/cues/ → ~/.cues/cues/. blanks/ + scripts/
  // stay. Flatten single-file folders. (Earlier code targeted words/;
  // post-2026-05 we restored the symmetric cues/ name.)
  fs.mkdirSync(newCuesDir, { recursive: true });
  const oldCuesSubdir = path.join(oldDir, 'cues');
  const newCuesSubdir = path.join(newCuesDir, 'cues');
  if (fs.existsSync(oldCuesSubdir)) {
    fs.mkdirSync(newCuesSubdir, { recursive: true });
    flattenInto(oldCuesSubdir, newCuesSubdir, log, 'cues');
    fs.rmdirSync(oldCuesSubdir);
  }
  for (const sub of ['blanks', 'scripts']) {
    const oldSub = path.join(oldDir, sub);
    const newSub = path.join(newCuesDir, sub);
    if (fs.existsSync(oldSub) && !fs.existsSync(newSub)) {
      fs.renameSync(oldSub, newSub);
      log(`  moved ${sub}/`);
    }
    // Flatten single-file folders inside blanks/ (script-less ones).
    if (sub === 'blanks' && fs.existsSync(newSub)) {
      flattenSingleFileFolders(newSub, log);
    }
  }

  // Stage 4 — drop the now-empty ~/.opencues/ dir.
  try {
    const remaining = fs.readdirSync(oldDir);
    if (remaining.length === 0) {
      fs.rmdirSync(oldDir);
      log(`  removed ${oldDir}`);
    } else {
      log(`  ${oldDir} not empty (${remaining.join(', ')}); left in place`);
    }
  } catch {}
  log('');
}

/**
 * Migrate legacy ~/.opencuesrc (rc-style YAML at $HOME) → new location
 * at ~/.cues/OPENCUES.md (markdown with frontmatter, sitting alongside
 * cues.md / blanks.md / auditors.md).
 *
 * Wraps the existing rc-style content in `---` frontmatter fences and
 * adds a doc body so the file matches the rest of the .cues/ layout.
 * Drops the legacy file after a successful copy. Idempotent — skips
 * when the new file already has content.
 *
 * `settingsTarget` is the new path; `legacy` is the old `.opencuesrc`
 * at $HOME. Both can be null (project-scope seed); we no-op then.
 */
function migrateOpencuesRcToOpencuesMd(legacy, settingsTarget, log) {
  if (!legacy || !settingsTarget) return;
  if (!fs.existsSync(legacy)) return;
  if (hasContent(settingsTarget)) {
    // Target already populated; assume user is on the new layout. Drop
    // the legacy file as a courtesy.
    try { fs.unlinkSync(legacy); log(`  removed stale ${legacy}`); } catch {}
    return;
  }
  const content = fs.readFileSync(legacy, 'utf8');
  // If the legacy file already has fences (rare — pre-migration shape
  // was supposed to be fence-less rc-style), pass through unchanged.
  // Otherwise wrap it.
  let body;
  if (/^---\n[\s\S]*?\n---/.test(content)) {
    body = content;
  } else {
    // Strip leading top-of-file comments (the legacy boilerplate
    // header) so the YAML inside the frontmatter starts cleanly.
    const yaml = content.replace(/^(?:[ \t]*#.*\n|\s*\n)+/, '');
    body = `---\n${yaml.replace(/\n+$/, '')}\n---\n\n` +
      `# OPENCUES.md — Runtime Configuration\n\n` +
      `Migrated from \`~/.opencuesrc\`. See \`defaults/OPENCUES.md\` for the\n` +
      `full annotated example with provider routing knobs and per-feature\n` +
      `LLM overrides.\n`;
  }
  fs.mkdirSync(path.dirname(settingsTarget), { recursive: true });
  fs.writeFileSync(settingsTarget, body);
  try { fs.unlinkSync(legacy); } catch {}
  log(`  migrated ${legacy} → ${settingsTarget}`);
}

/**
 * Migrate `~/.cues/words/` → `~/.cues/cues/`. The post-2026-05 layout
 * restores symmetry with `cues.md` (master file + per-item folder
 * sharing the same name, like `blanks.md` + `blanks/`).
 *
 * Strategy: if `cues/` doesn't exist, simple rename. If both exist
 * (rare — user manually created cues/ alongside words/), copy each
 * words/* into cues/ unless a same-named entry is already there
 * (cues/ wins), then remove the empty words/. Idempotent.
 */
function migrateWordsToCues(targetDir, log) {
  const wordsDir = path.join(targetDir, 'words');
  const cuesDir = path.join(targetDir, 'cues');
  if (!fs.existsSync(wordsDir)) return;
  if (!fs.existsSync(cuesDir)) {
    fs.renameSync(wordsDir, cuesDir);
    log(`  migrated ${wordsDir} → ${cuesDir}`);
    return;
  }
  let merged = 0;
  for (const entry of fs.readdirSync(wordsDir, { withFileTypes: true })) {
    const src = path.join(wordsDir, entry.name);
    const dst = path.join(cuesDir, entry.name);
    if (fs.existsSync(dst)) continue;                            // cues/ wins
    fs.renameSync(src, dst);
    merged += 1;
  }
  // Drop words/ if empty after merge; otherwise leave with leftover
  // entries so the user can resolve conflicts manually.
  try { fs.rmdirSync(wordsDir); log(`  migrated ${wordsDir} → ${cuesDir} (${merged} entries merged, words/ removed)`); }
  catch { log(`  partially migrated ${wordsDir} → ${cuesDir} (${merged} merged; words/ has remaining entries — resolve manually)`); }
}

/** Move every entry from `src` to `dst`, flattening single-file folders
 *  (folders containing only a `cue.md` and nothing else become flat
 *  `<name>.md` files). Folders with colocated assets (scripts, .cs)
 *  are moved as-is. */
function flattenInto(src, dst, log, label) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    if (entry.isDirectory()) {
      const cueMd = path.join(srcPath, 'cue.md');
      const otherFiles = fs.existsSync(cueMd)
        ? fs.readdirSync(srcPath).filter(f => f !== 'cue.md')
        : null;
      if (otherFiles && otherFiles.length === 0) {
        // Single-file folder — flatten.
        fs.renameSync(cueMd, path.join(dst, entry.name + '.md'));
        fs.rmdirSync(srcPath);
        log(`  flattened ${label}/${entry.name}.md`);
      } else {
        // Folder with assets — move as-is.
        fs.renameSync(srcPath, path.join(dst, entry.name));
        log(`  moved ${label}/${entry.name}/`);
      }
    } else if (entry.name.endsWith('.md')) {
      fs.renameSync(srcPath, path.join(dst, entry.name));
      log(`  moved ${label}/${entry.name}`);
    }
  }
}

/** Flatten any single-file <folder>/cue.md inside `dir` to <folder>.md.
 *  Used for blanks/ where some sources have scripts (kept as folders)
 *  and others don't (flattened). */
function flattenSingleFileFolders(dir, log) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(dir, entry.name);
    const cueMd = path.join(sub, 'cue.md');
    if (!fs.existsSync(cueMd)) continue;
    const otherFiles = fs.readdirSync(sub).filter(f => f !== 'cue.md');
    if (otherFiles.length === 0) {
      fs.renameSync(cueMd, path.join(dir, entry.name + '.md'));
      fs.rmdirSync(sub);
      log(`  flattened ${path.basename(dir)}/${entry.name}.md`);
    }
  }
}

/** Pre-OpenStandard legacy migration (kept for users mid-migration).
 *  Pulls settings from opencues.md into cues.md, splits ## Tips into
 *  folders, etc. Operates in-place inside the OLD `~/.opencues/`. */
function migrateLegacyContents(targetDir, log) {
  const opencuesPath = path.join(targetDir, 'opencues.md');
  const cuesPath = path.join(targetDir, 'cues.md');
  const blanksPath = path.join(targetDir, 'blanks.md');

  const hasOldOpencues = fs.existsSync(opencuesPath);
  const hasOldCues = fs.existsSync(cuesPath);
  const hasOldBlanks = fs.existsSync(blanksPath);

  // Quick exit when nothing to migrate. Look for any signal that the
  // old layout is still present — opencues.md OR cues.md with a `## Tips`
  // body section OR blanks.md (assumed legacy if it exists).
  let cuesContent = hasOldCues ? fs.readFileSync(cuesPath, 'utf8') : null;
  const hasTipsSection = cuesContent ? /^## Tips/m.test(cuesContent) : false;
  const hasIgnoreSection = cuesContent ? /^## Ignore/m.test(cuesContent) : false;
  const hasBlanksSection = cuesContent ? /^## Blanks/m.test(cuesContent) : false;

  if (!hasOldOpencues && !hasTipsSection && !hasIgnoreSection && !hasBlanksSection && !hasOldBlanks) {
    return; // already migrated
  }

  log('Migrating legacy layout (opencues.md + ## Tips + ## Ignore + blanks.md → unified cues.md):');

  // Read the two source files.
  const opencuesContent = hasOldOpencues ? fs.readFileSync(opencuesPath, 'utf8') : '';
  if (!cuesContent) cuesContent = '---\nname: cues\n---\n\n# cues.md\n';

  // Parse frontmatters.
  const opencuesFm = extractFrontmatterRaw(opencuesContent);
  const cuesParsed = splitFrontmatter(cuesContent);

  // Merge frontmatters: cues.md frontmatter wins on duplicate keys (the
  // user's local cues.md overrides shipped opencues.md). The opencues.md
  // frontmatter is multi-line YAML (settings: block); preserve it as a
  // raw block.
  const cuesFmKeys = new Set();
  for (const line of cuesParsed.frontmatter.split('\n')) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_\- ]*?):/);
    if (m) cuesFmKeys.add(m[1]);
  }
  const opencuesFmFiltered = opencuesFm.split('\n')
    .filter(line => {
      const m = line.match(/^([A-Za-z][A-Za-z0-9_\- ]*?):/);
      // Drop lines whose key is already in cues.md frontmatter; keep
      // indented lines (they belong to the settings: block above).
      return !m || !cuesFmKeys.has(m[1]) || /^\s/.test(line);
    })
    .join('\n');

  // Walk the cues.md body: pull out ## Tips JSON groups, ## Ignore list.
  // Strip those sections from the body.
  const body = cuesParsed.body;
  const tipsGroups = extractTipsJsonGroups(body);
  const ignoreList = extractIgnoreList(body);
  let strippedBody = stripSection(body, 'Tips');
  strippedBody = stripSection(strippedBody, 'Ignore');
  strippedBody = stripSection(strippedBody, 'Blanks');

  // Build new frontmatter: cues frontmatter (minus version which is
  // a single-source-of-truth for the master file) + opencues frontmatter
  // + ignore: array if any.
  const newFmLines = [];
  newFmLines.push(cuesParsed.frontmatter.replace(/\s+$/, ''));
  if (opencuesFmFiltered.trim()) newFmLines.push(opencuesFmFiltered.replace(/\s+$/, ''));
  if (ignoreList.length > 0) newFmLines.push(`ignore: ${JSON.stringify(ignoreList)}`);
  const newFm = newFmLines.filter(Boolean).join('\n');

  const newCuesMd = `---\n${newFm}\n---\n${strippedBody.replace(/^\s+/, '\n')}`;
  fs.writeFileSync(cuesPath, newCuesMd);
  log(`  rewrote ${cuesPath}`);

  // Consolidate all tip groups into ONE folder: cues/tips/cue.md.
  // Body is the legacy array shape `[{id, words?, groups?}]` — the
  // parser still accepts it directly.
  if (tipsGroups.length > 0) {
    const tipsFolder = path.join(targetDir, 'cues', 'tips');
    const tipsCueMd = path.join(tipsFolder, 'cue.md');
    if (fs.existsSync(tipsCueMd)) {
      log(`  skip cues/tips/ (already exists)`);
    } else {
      fs.mkdirSync(tipsFolder, { recursive: true });
      const bodyJson = JSON.stringify(tipsGroups, null, 2);
      const content = `---\nname: tips\n---\n\n\`\`\`json\n${bodyJson}\n\`\`\`\n`;
      fs.writeFileSync(tipsCueMd, content);
      log(`  created cues/tips/cue.md (${tipsGroups.length} groups)`);
    }
  }

  // Drop legacy files.
  if (hasOldOpencues) {
    fs.unlinkSync(opencuesPath);
    log(`  deleted ${opencuesPath}`);
  }
  if (hasOldBlanks) {
    fs.unlinkSync(blanksPath);
    log(`  deleted ${blanksPath}`);
  }
  log('');
}

function extractFrontmatterRaw(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return m ? m[1] : '';
}

function splitFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: '', body: content };
  return { frontmatter: m[1], body: content.slice(m[0].length) };
}

function extractTipsJsonGroups(body) {
  const m = body.match(/^## Tips\s*\n+```json\n([\s\S]*?)\n```/m);
  if (!m) return [];
  try {
    const data = JSON.parse(m[1]);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function extractIgnoreList(body) {
  const m = body.match(/^## Ignore\s*\n([\s\S]*?)(?=\n## |\n*$)/m);
  if (!m) return [];
  return m[1].split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

function stripSection(body, heading) {
  const re = new RegExp(`^## ${heading}[\\s\\S]*?(?=^## |$(?![\\s\\S]))`, 'm');
  return body.replace(re, '');
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
