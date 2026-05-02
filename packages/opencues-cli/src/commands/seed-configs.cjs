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
//   ~/.opencues/ is shared across CC + OC + Codex. Putting these writes
//   inside CC's setup.sh meant OC + Codex users only got refreshes if
//   they happened to also install CC. That coupling is gone — every host
//   installer invokes seed-configs first, and standalone `opencues
//   seed-configs` does the same work.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// First-time copy targets. cues.md is the master config (settings +
// ignore + project metadata in frontmatter). cues/ + blanks/ are the
// per-source folders. scripts/ holds shared shell helpers (TTS, …),
// user-level only.
const SEED_FILES_USER = ['cues.md', 'cues', 'blanks', 'scripts'];
const SEED_FILES_PROJECT = ['cues.md', 'cues', 'blanks'];

module.exports = function seedConfigs(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const dryRun = argv.includes('--dry-run');
  const projectScope = argv.includes('--project');
  const silent = argv.includes('--silent');
  const log = silent ? () => {} : console.log.bind(console);

  const HOME = os.homedir();
  const targetDir = projectScope
    ? path.join(process.cwd(), '.opencues')
    : path.join(HOME, '.opencues');
  const sourceDir = path.join(ctx.REPO_ROOT, 'defaults');

  if (!fs.existsSync(sourceDir)) {
    console.error(`opencues seed-configs: source dir not found at ${sourceDir}`);
    console.error(`(this command must run from inside an opencues clone today)`);
    process.exit(1);
  }

  log(`Seeding ${projectScope ? 'project' : 'user'}-level configs:`);
  log(`  source: ${sourceDir}`);
  log(`  target: ${targetDir}`);
  log('');

  // ── 0. MIGRATE — old layout (opencues.md + cues.md ## Tips +
  // blanks.md) → new unified layout. Idempotent: re-running after
  // migration is a no-op (signals are gone). User-scope only.
  if (!projectScope && !dryRun) {
    migrateLegacyLayout(targetDir, log);
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

  // If we skipped anything, surface the gotcha. SEED is first-time-only by
  // design (preserves user customisations), but that means new fields added
  // to shipped defaults DON'T flow into existing user files. Common bite:
  // opencues.md gets new opt-in flags (fluid-blank-mode, spelling-mode,
  // etc.) and the user's existing opencues.md silently lacks them →
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
  // cues/<name>) that exist in defaults/ but not yet in ~/.opencues/.
  // The original SEED phase only copies the top-level `blanks/` dir
  // once; new shipped blanks (or cues) added in a later release would
  // otherwise be silently missed. .md inside copied subdirs is user
  // content from then on (SYNC won't touch it). ──────────────────────
  log('');
  log('Additive seed (new subdirs from defaults/{cues,blanks}/):');
  let added = 0;
  for (const parent of ['cues', 'blanks']) {
    const srcParent = path.join(sourceDir, parent);
    const dstParent = path.join(HOME, '.opencues', parent);
    if (!fs.existsSync(srcParent)) continue;
    fs.mkdirSync(dstParent, { recursive: true });
    for (const subSrc of listChildDirs(srcParent)) {
      const sub = path.basename(subSrc);
      const subDst = path.join(dstParent, sub);
      if (fs.existsSync(subDst)) continue; // user already has it (or opted out)
      copyDir(subSrc, subDst);
      added++;
      log(`  added ${parent}/${sub}/`);
    }
  }
  if (added === 0) log('  (no new subdirs)');

  // ── 2. SYNC — library files (always overwrite if differs) ──────────
  log('');
  log('Library sync (.sh/.cs/.ps1 from defaults — never overwrites .md):');
  let synced = 0;

  // 2a. defaults/blanks/<name>/ → ~/.opencues/blanks/<name>/
  for (const ctlDir of listChildDirs(path.join(sourceDir, 'blanks'))) {
    const ctl = path.basename(ctlDir);
    const userDir = path.join(HOME, '.opencues/blanks', ctl);
    if (!fs.existsSync(userDir)) continue; // not seeded → user opted out
    for (const src of listFilesByExt(ctlDir, ['.sh', '.cs', '.ps1'])) {
      const dst = path.join(userDir, path.basename(src));
      if (syncIfDiffers(src, dst)) { synced++; log(`  synced ${dst}`); }
    }
  }

  // 2b. defaults/scripts/ → ~/.opencues/scripts/
  const scriptsSrc = path.join(sourceDir, 'scripts');
  const scriptsDst = path.join(HOME, '.opencues/scripts');
  if (fs.existsSync(scriptsSrc)) {
    fs.mkdirSync(scriptsDst, { recursive: true });
    for (const src of listFilesByExt(scriptsSrc, ['.sh', '.cs', '.ps1'])) {
      const dst = path.join(scriptsDst, path.basename(src));
      if (syncIfDiffers(src, dst)) { synced++; log(`  synced ${dst}`); }
    }
  }

  if (synced === 0) log('  (no changes — library files current)');

  // ── 3. HEAL — self-heal empty cues.md ──────────────────────────────
  log('');
  const userCuesMd = path.join(HOME, '.opencues/cues.md');
  const repoCuesMd = path.join(sourceDir, 'cues.md');
  if (fs.existsSync(userCuesMd) && fs.statSync(userCuesMd).size === 0 && hasContent(repoCuesMd)) {
    fs.copyFileSync(repoCuesMd, userCuesMd);
    log(`Self-heal: reseeded empty ${userCuesMd} from defaults`);
  }

  // ── 4. COMPILE — colocated .cs → .exe (WSL only) ───────────────────
  const csc = '/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
  if (fs.existsSync(csc)) {
    log('');
    log('Compile (.cs → .exe, WSL):');
    let compiled = 0;
    // 4a. blanks/<name>/*.cs colocated.
    for (const userDir of listChildDirs(path.join(HOME, '.opencues/blanks'))) {
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

// ─── Migration: legacy layout → unified cues.md ──────────────────────────
//
// Old shape:
//   ~/.opencues/opencues.md     — settings frontmatter
//   ~/.opencues/cues.md         — `## Tips` JSON + `## Ignore` body
//   ~/.opencues/blanks.md       — empty/legacy
//
// New shape:
//   ~/.opencues/cues.md         — settings frontmatter + ignore: array
//                                 (no body sections — tips moved out)
//   ~/.opencues/cues/<id>/cue.md — one folder per tip group
//   blanks.md gone entirely
//
// Migration steps (all idempotent):
//   1. If opencues.md exists, read its frontmatter and merge it into
//      the cues.md frontmatter (cues.md wins on duplicate keys).
//   2. If cues.md has a `## Tips` JSON block, split each group into
//      cues/<group-id>/cue.md.
//   3. If cues.md has a `## Ignore` body section, move it into the
//      frontmatter as `ignore: [...]`.
//   4. Strip the migrated body sections from cues.md, leaving frontmatter
//      and any remaining markdown.
//   5. Delete opencues.md and blanks.md after the merge succeeds.
function migrateLegacyLayout(targetDir, log) {
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

  // Spawn each tip group as a folder.
  const cuesFolderDir = path.join(targetDir, 'cues');
  fs.mkdirSync(cuesFolderDir, { recursive: true });
  for (const group of tipsGroups) {
    const id = group.id;
    if (!id) continue;
    const folder = path.join(cuesFolderDir, id);
    if (fs.existsSync(folder)) {
      log(`  skip cues/${id}/ (already exists)`);
      continue;
    }
    fs.mkdirSync(folder, { recursive: true });
    // Body JSON is the full section minus the id (id becomes folder name).
    const sectionData = { ...group };
    delete sectionData.id;
    const bodyJson = JSON.stringify(sectionData, null, 2);
    const content = `---\nname: ${id}\n---\n\n\`\`\`json\n${bodyJson}\n\`\`\`\n`;
    fs.writeFileSync(path.join(folder, 'cue.md'), content);
    log(`  created cues/${id}/cue.md`);
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
