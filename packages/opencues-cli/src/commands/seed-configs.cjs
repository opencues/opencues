// `opencues seed-configs` — host-agnostic. Manages the user-level
// ~/.cues/ tree.
//
// Four responsibilities, all idempotent + safe to re-run:
//
//   1. SEED   first-time copy of repo defaults → ~/.cues/
//             (CUES.md, BLANKS.md, OPENCUES.md, AUDITORS.md, USER.md,
//              cues/, blanks/, auditors/, scripts/)
//             Skips files that already exist with content (preserves user edits).
//
//   2. SYNC   library-script refresh on every run.
//             ~/.cues/{blanks/<name>,scripts}/{*.sh,*.cs,*.ps1} ← repo defaults
//             These are LIBRARY code (not user content). They ship with the
//             repo, the user normally doesn't edit them, and stale copies
//             silently break things when paths change. Sync overwrites if
//             content differs from the repo source. .md files (user content)
//             are NEVER touched here.
//
//   3. HEAL   self-heal a 0-byte ~/.cues/OPENCUES.md.
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
//   ~/.cues/ is shared across CC + OC. Putting these writes
//   inside CC's setup.sh meant OC users only got refreshes if
//   they happened to also install CC. That coupling is gone — every host
//   installer invokes seed-configs first, and standalone `opencues
//   seed-configs` does the same work.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { tag, bold, dim, fileLink, tree, banner, cliVersion } = require('../lib/style.cjs');

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
  // library directory, alongside CUES.md / BLANKS.md / AUDITORS.md.
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

  log(banner({ version: cliVersion(ctx), tagline: `seeding ${projectScope ? 'project' : 'user'}-level configs` }));
  log('');
  log(`  ${dim('source:')} ${fileLink(sourceDir, sourceDir)}`);
  log(`  ${dim('target:')} ${fileLink(targetDir, targetDir)}`);
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

  const planRows = plan.map(p => {
    if (!p.srcExists) return [p.name, dim('(no source)')];
    if (p.dstExists)  return [p.name, dim('SKIP (exists)') + ' ' + fileLink(p.dst, p.dst)];
    if (fs.existsSync(p.dst)) return [p.name, dim('RESEED (empty)') + ' ' + fileLink(p.dst, p.dst), tag('warn')];
    return [p.name, dim('COPY') + ' ' + fileLink(p.src, p.src) + ' ' + dim('→') + ' ' + fileLink(p.dst, p.dst), tag('ok')];
  });
  log(tree({ title: 'Seed plan', description: 'first-time copies — never overwrites existing files', rows: planRows }));

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
  log(`${tag('ok')} seeded ${bold(copied)}, skipped ${bold(skipped)}`);

  // Seed `OPENCUES.md` — the system-settings file. When it already exists
  // with content, MERGE: preserve user's top-level scalar VALUES + any
  // user-only scalars; replace the `settings:` block from defaults (the
  // block is runtime-owned schema, not user content); preserve user's
  // body. Without this, new scalars/settings entries shipped in defaults
  // silently strand on existing installs and the selector blank can't
  // see them. The `settings:` block already documents itself as schema:
  // "additions get overwritten on state writes".
  if (settingsTarget && fs.existsSync(settingsSource)) {
    if (hasContent(settingsTarget)) {
      const defaultsContent = fs.readFileSync(settingsSource, 'utf8');
      const userContent = fs.readFileSync(settingsTarget, 'utf8');
      const merged = mergeOpencuesMd(defaultsContent, userContent);
      if (merged !== userContent) {
        fs.writeFileSync(settingsTarget, merged);
        log(`  ${tag('ok')} merged ${path.basename(settingsTarget)} (kept your scalar values; refreshed settings: schema)`);
      } else {
        log(`  ${dim('SKIP (current)')} ${settingsTarget}`);
      }
    } else {
      fs.mkdirSync(path.dirname(settingsTarget), { recursive: true });
      fs.copyFileSync(settingsSource, settingsTarget);
      log(`  copied ${path.basename(settingsTarget)}`);
    }
  }

  // Seed every optional templated file from the @opencues/core registry.
  // Today: AUDITORS.md (core) + USER.md (feature). Adding a new templated
  // file = appending to CORE_TEMPLATES or to a feature's prereqFile.template;
  // no edit to this loop required.
  if (!projectScope) {
    let registry;
    try {
      // ctx isn't available at this scope — locate via __dirname walk
      const corePath = path.resolve(__dirname, '../../../opencues-core/dist/feature-registry.js');
      registry = require(corePath);
    } catch { registry = null; }
    if (registry?.seedableOptionalFiles) {
      for (const seed of registry.seedableOptionalFiles()) {
        const target = path.join(targetDir, seed.basename);
        const source = path.join(sourceDir, seed.basename);
        if (!fs.existsSync(source)) continue;
        if (hasContent(target)) {
          log(`  ${dim('SKIP (exists)')} ${target}`);
        } else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(source, target);
          const suffix = seed.mustHavePopulatedFields
            ? ' (template — populate fields to opt in)'
            : '';
          log(`  ${tag('ok')} copied ${seed.basename}${suffix}`);
        }
      }
    }
  }

  // If we skipped anything, surface the gotcha. SEED is first-time-only by
  // design (preserves user customisations), but that means new fields added
  // to shipped defaults DON'T flow into existing user files. Common bite:
  // OPENCUES.md gets new opt-in flags (fluid-blank-mode, etc.)
  // and the user's existing OPENCUES.md silently lacks them →
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

  // ── 1.5 ADDITIVE SEED — copy in any NEW subdirs that exist under
  // defaults/{cues,blanks,auditors}/ but not yet in ~/.cues/. The
  // original SEED phase only copies each top-level dir once on first
  // install; new shipped tip groups, blanks, or auditors added in a
  // later release would otherwise be silently missed. .md content
  // inside copied subdirs is user content from then on (SYNC won't
  // touch it). ─────────────────────────────────────────────────────
  log('');
  const addedEntries = [];
  for (const parent of ['cues', 'blanks', 'auditors']) {
    const srcParent = path.join(sourceDir, parent);
    const dstParent = path.join(targetDir, parent);
    if (!fs.existsSync(srcParent)) continue;
    fs.mkdirSync(dstParent, { recursive: true });
    for (const entry of fs.readdirSync(srcParent, { withFileTypes: true })) {
      const subSrc = path.join(srcParent, entry.name);
      const subDst = path.join(dstParent, entry.name);
      if (fs.existsSync(subDst)) continue;
      if (!entry.isDirectory()) continue;
      copyDir(subSrc, subDst);
      addedEntries.push(`${parent}/${entry.name}/`);
    }
  }
  const additiveRows = addedEntries.length
    ? addedEntries.map(e => [e, '', tag('ok')])
    : [[dim('(no new entries)'), '']];
  log(tree({ title: 'Additive seed', description: 'new entries shipped in defaults/{cues,blanks,auditors}/ since last run', rows: additiveRows }));

  // ── 2. SYNC — library files (always overwrite if differs) ──────────
  log('');
  const syncedFiles = [];

  // 2a. defaults/blanks/<name>/ → ~/.cues/blanks/<name>/
  for (const ctlDir of listChildDirs(path.join(sourceDir, 'blanks'))) {
    const ctl = path.basename(ctlDir);
    const userDir = path.join(targetDir, 'blanks', ctl);
    if (!fs.existsSync(userDir)) continue;
    for (const src of listFilesByExt(ctlDir, ['.sh', '.cs', '.ps1'])) {
      const dst = path.join(userDir, path.basename(src));
      if (syncIfDiffers(src, dst)) syncedFiles.push(dst);
    }
  }

  // 2b. defaults/scripts/ → ~/.cues/scripts/
  const scriptsSrc = path.join(sourceDir, 'scripts');
  const scriptsDst = path.join(targetDir, 'scripts');
  if (fs.existsSync(scriptsSrc)) {
    fs.mkdirSync(scriptsDst, { recursive: true });
    for (const src of listFilesByExt(scriptsSrc, ['.sh', '.cs', '.ps1'])) {
      const dst = path.join(scriptsDst, path.basename(src));
      if (syncIfDiffers(src, dst)) syncedFiles.push(dst);
    }
  }

  const syncRows = syncedFiles.length
    ? syncedFiles.map(f => [fileLink(f, f), '', tag('ok')])
    : [[dim('(no changes — library files current)'), '']];
  log(tree({ title: 'Library sync', description: '.sh / .cs / .ps1 helpers refreshed from defaults', rows: syncRows }));

  // ── 2.5 SHIPPED-MD REFRESH — pull latest frontmatter for shipped
  //       cues/blanks/auditors, layer user values on top. Without this,
  //       changes to defaults' contract fields (on-host, sandbox,
  //       blankReplace) silently strand on existing installs — exactly
  //       what bit users when the security push retired `codex` and
  //       added `gemini-cli` to on-host: lists across shipped blanks.
  //       User-customisable fields (priority, keywords, blankStep,
  //       prompt body) are preserved; contract fields refresh from
  //       defaults. Mirrors mergeOpencuesMd but for the shipped
  //       library files. ─────────────────────────────────────────────
  log('');
  const mdRefreshed = [];
  for (const subdir of ['cues', 'blanks', 'auditors']) {
    const srcParent = path.join(sourceDir, subdir);
    const dstParent = path.join(targetDir, subdir);
    if (!fs.existsSync(srcParent) || !fs.existsSync(dstParent)) continue;
    const mdName = subdir === 'cues' ? 'CUE.md' : (subdir === 'blanks' ? 'BLANK.md' : 'AUDITOR.md');
    for (const ctlDir of listChildDirs(srcParent)) {
      const name = path.basename(ctlDir);
      const srcMd = path.join(ctlDir, mdName);
      const dstMd = path.join(dstParent, name, mdName);
      if (!fs.existsSync(srcMd) || !fs.existsSync(dstMd)) continue;
      const srcContent = fs.readFileSync(srcMd, 'utf8');
      const dstContent = fs.readFileSync(dstMd, 'utf8');
      const merged = mergeShippedMd(srcContent, dstContent);
      if (merged !== dstContent) {
        fs.writeFileSync(dstMd, merged);
        mdRefreshed.push(`${subdir}/${name}/${mdName}`);
      }
    }
  }
  const refreshRows = mdRefreshed.length
    ? mdRefreshed.map(f => [f, dim('contract fields refreshed; user fields preserved'), tag('ok')])
    : [[dim('(no changes — shipped frontmatter current)'), '']];
  log(tree({ title: 'Shipped .md refresh', description: 'pull latest contract fields from defaults; preserve user customisations', rows: refreshRows }));

  // ── 3. HEAL — self-heal empty OPENCUES.md + rename legacy cue.md → blank.md ──
  log('');
  if (settingsTarget && hasContent(settingsSource)) {
    if (fs.existsSync(settingsTarget) && fs.statSync(settingsTarget).size === 0) {
      fs.copyFileSync(settingsSource, settingsTarget);
      log(`Self-heal: reseeded empty ${settingsTarget} from defaults`);
    }
  }

  // ── 3.1 HEAL — rename legacy bucket scalars in OPENCUES.md ──
  //
  // The three-bucket simplification (cues / auditors / blanks)
  // renamed the singular `blank-llm-provider:` / `blank-llm-model:` /
  // `blank-llm-endpoint:` scalars to plural `blanks-llm-*`. The
  // runtime still reads the old keys (back-compat in
  // config-loader.ts), but only one release cycle — this self-heal
  // rewrites legacy → new in place so the fallback can be dropped in
  // a future release without losing user settings.
  //
  // Idempotent: skips lines that already use the new name. Single-line
  // rewrite per key — preserves position in frontmatter + any
  // user-trailing comments.
  if (settingsTarget && fs.existsSync(settingsTarget) && fs.statSync(settingsTarget).size > 0) {
    const original = fs.readFileSync(settingsTarget, 'utf8');
    let rewritten = original;
    const renames = [
      ['blank-llm-provider', 'blanks-llm-provider'],
      ['blank-llm-model',    'blanks-llm-model'],
      ['blank-llm-endpoint', 'blanks-llm-endpoint'],
    ];
    const renamed = [];
    for (const [oldKey, newKey] of renames) {
      // Skip if the file already has the new key — never overwrite the
      // user's intentional value with a legacy one.
      const hasNew = new RegExp(`^${newKey}:`, 'm').test(rewritten);
      if (hasNew) continue;
      const re = new RegExp(`^${oldKey}:`, 'm');
      if (re.test(rewritten)) {
        rewritten = rewritten.replace(re, `${newKey}:`);
        renamed.push(`${oldKey} → ${newKey}`);
      }
    }
    if (rewritten !== original) {
      fs.writeFileSync(settingsTarget, rewritten);
      log(`Self-heal: renamed legacy bucket scalars in ${settingsTarget}: ${renamed.join(', ')}`);
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

  // Cleanup: drop legacy `<targetDir>/{cues,blanks,auditors}/<name>.md`
  // files when the folder form (`<name>/{CUE,BLANK,AUDITOR}.md`) is
  // also present. The user-blank migration (May 2026) moved every
  // built-in blank from the flat-file shape to folder shape; additive
  // seed copied the new folders in, but the old top-level .md files
  // strand. The runtime ignores them (discover.ts skips non-directory
  // entries) but they're dead weight, confuse readers, and look like
  // active config.
  for (const subdir of ['cues', 'blanks', 'auditors']) {
    const parent = path.join(targetDir, subdir);
    if (!fs.existsSync(parent)) continue;
    const mdName = subdir === 'cues' ? 'CUE.md' : (subdir === 'blanks' ? 'BLANK.md' : 'AUDITOR.md');
    const culled = [];
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const baseName = entry.name.slice(0, -3);  // drop ".md"
      const folderForm = path.join(parent, baseName, mdName);
      if (fs.existsSync(folderForm)) {
        fs.unlinkSync(path.join(parent, entry.name));
        culled.push(`${subdir}/${entry.name}`);
      }
    }
    if (culled.length > 0) {
      log(`Self-heal: removed ${culled.length} legacy flat-file ${subdir} entries (superseded by folder form): ${culled.join(', ')}`);
    }
  }

  // ── 3.5 HEAL — built-in / user-blank collision cleanup ─────────────
  //
  // Before May 2026 we shipped a TS class in BUILTIN_BLANKS AND a
  // duplicate user-blank script at `defaults/blanks/<name>/blank.js`
  // for the same name. Native hosts (CC/OC/gemini) preferred the
  // user-blank when both existed; chrome preferred the built-in.
  // Silent per-host divergence — same name, different impl.
  //
  // Option B (this codebase, May 2026) deleted the duplicate user-
  // blank scripts and dropped `impl:` from the shipped BLANK.md. But
  // `seed-configs` is first-time-only for `.md`, SYNC doesn't touch
  // `.js`, and `mergeShippedMd` preserves `impl:` as a "user-only
  // field". Existing installs therefore keep the stale user-blank
  // running on native hosts.
  //
  // This heal closes the gap: for each BUILTIN_BLANKS name where the
  // user's BLANK.md still declares `impl: ./blank.js` (the shipped
  // default shape), strip that line + the JS-only capability fields
  // (`network:` / `storage:` / `secrets:` / `secret-hosts.*:` /
  // `llm:`) and delete the colocated `blank.js`. User-customised
  // impls (different filename, or BLANK.md edited beyond the shipped
  // shape) are left alone — the guard is "impl: ./blank.js" exactly.
  if (!projectScope) {
    const healed = healBuiltinUserBlankCollisions(userBlanksDir, log);
    if (healed.length > 0) {
      log(`Self-heal: cleaned ${healed.length} built-in/user-blank collision(s): ${healed.join(', ')}`);
    }
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
 *  silently no-ops, e.g. an empty OPENCUES.md hides "opencues ___" blank-fills. */
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

/** Discover the BUILTIN_BLANKS name list at runtime. Walks the
 *  @opencues/runtime install relative to the CLI to avoid a hard
 *  workspace dependency. Returns an empty Set on any failure (the
 *  heal step degrades to no-op rather than crashing seed-configs). */
function loadBuiltinBlankNames() {
  try {
    const runtimePath = path.resolve(__dirname, '../../../opencues-runtime/dist/src/blanks/index.js');
    const mod = require(runtimePath);
    const list = Array.isArray(mod?.BUILTIN_BLANKS) ? mod.BUILTIN_BLANKS : [];
    return new Set(list.map(spec => spec && spec.name).filter(Boolean));
  } catch { return new Set(); }
}

/** Strip a frontmatter line by exact key match (top-level only — leading
 *  whitespace is treated as "indented, not top-level"). Returns the
 *  rewritten content. Keys: array of literal key names (case-sensitive). */
function stripFrontmatterKeys(mdContent, keysToStrip, keyPrefixesToStrip) {
  const m = mdContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return mdContent;
  const [, fm, body] = m;
  const out = [];
  for (const line of fm.split('\n')) {
    if (line.startsWith(' ') || line.startsWith('\t')) { out.push(line); continue; }
    const km = line.match(/^([a-zA-Z][a-zA-Z0-9_.-]*):/);
    if (km && keysToStrip.includes(km[1])) continue;
    if (km && keyPrefixesToStrip.some(p => km[1].startsWith(p))) continue;
    out.push(line);
  }
  return `---\n${out.join('\n')}\n---\n${body}`;
}

/** For each BUILTIN_BLANKS name where the user's BLANK.md still ships
 *  `impl: ./blank.js` (the shipped default shape), strip that line +
 *  the JS-only capability fields (`network:` / `storage:` / `secrets:` /
 *  `secret-hosts.*:` / `llm:`) and delete the colocated `blank.js`.
 *  Skips user-customised impl paths (anything other than `./blank.js`).
 *  Returns the list of healed names. */
function healBuiltinUserBlankCollisions(userBlanksDir, log) {
  if (!fs.existsSync(userBlanksDir)) return [];
  const builtinNames = loadBuiltinBlankNames();
  if (builtinNames.size === 0) return [];
  const SHIPPED_IMPL_RE = /^[ \t]*impl:[ \t]*\.\/blank\.js[ \t]*$/m;
  const STRIP_KEYS = ['impl', 'network', 'storage', 'secrets', 'llm'];
  const STRIP_PREFIXES = ['secret-hosts.'];
  const healed = [];
  for (const subDir of listChildDirs(userBlanksDir)) {
    const name = path.basename(subDir);
    if (!builtinNames.has(name)) continue;
    const mdPath = path.join(subDir, 'BLANK.md');
    if (!fs.existsSync(mdPath)) continue;
    const before = fs.readFileSync(mdPath, 'utf8');
    if (!SHIPPED_IMPL_RE.test(before)) continue;  // not the shipped shape — leave alone
    const after = stripFrontmatterKeys(before, STRIP_KEYS, STRIP_PREFIXES);
    if (after !== before) fs.writeFileSync(mdPath, after);
    const jsPath = path.join(subDir, 'blank.js');
    if (fs.existsSync(jsPath)) {
      try { fs.unlinkSync(jsPath); }
      catch (err) { log(`  warn: could not delete ${jsPath}: ${err.message}`); }
    }
    healed.push(name);
  }
  return healed;
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
// Safe merge for OPENCUES.md. Defaults is the skeleton (comments + structure
// + the runtime-owned settings: block); user file contributes scalar values.
//
// Algorithm:
//   1. Split each file into frontmatter + body at the YAML `---` fences.
//   2. From user's frontmatter, extract top-level `key: value` scalars
//      (no leading whitespace; stops at the `settings:` line so indented
//      keys inside the settings block don't bleed in).
//   3. Walk defaults' frontmatter line-by-line: where a default scalar has
//      a matching user key, substitute the user's value. Once we hit
//      `settings:`, the rest of defaults' frontmatter copies through
//      verbatim (schema refresh).
//   4. Append any user-only scalars (keys present in user but not in
//      defaults) just above the `settings:` line so they survive.
//   5. Reassemble: defaults' merged frontmatter + user's body (or defaults'
//      body when user had none).
//
// Idempotent: a second run produces the same output. Returns the merged
// string; caller decides whether to write it.
function mergeOpencuesMd(defaultsContent, userContent) {
  const split = (text) => {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return { fm: '', body: text };
    return { fm: m[1], body: m[2] };
  };
  const d = split(defaultsContent);
  const u = split(userContent);

  const SCALAR_RE = /^([a-z][a-z0-9_-]*):\s*(.*)$/;

  // Pull user's top-level scalars (ignore everything from the settings: line
  // onward — those are indented schema keys, not user-customisable scalars).
  const userScalars = new Map();
  {
    let inSettings = false;
    for (const line of u.fm.split('\n')) {
      if (/^settings\s*:/.test(line)) { inSettings = true; continue; }
      if (inSettings) continue;
      const m = line.match(SCALAR_RE);
      if (m) userScalars.set(m[1], m[2]);
    }
  }

  // Walk defaults' frontmatter, substituting user values for keys above the
  // settings: block. Track which user scalars matched a default key so we
  // know which are user-only (to preserve below).
  const matchedKeys = new Set();
  const mergedLines = [];
  let inSettingsBlock = false;
  for (const line of d.fm.split('\n')) {
    if (!inSettingsBlock && /^settings\s*:/.test(line)) {
      // Insert user-only scalars just above the settings: line so they
      // survive future merges (they'll match again on the next pass).
      const extras = [];
      for (const [k, v] of userScalars) {
        if (!matchedKeys.has(k)) extras.push(`${k}: ${v}`);
      }
      if (extras.length > 0) {
        mergedLines.push('# ── User-only scalars (preserved by seed-configs merge) ──');
        mergedLines.push(...extras);
        mergedLines.push('');
      }
      inSettingsBlock = true;
      mergedLines.push(line);
      continue;
    }
    if (inSettingsBlock) { mergedLines.push(line); continue; }
    const m = line.match(SCALAR_RE);
    if (m && userScalars.has(m[1])) {
      matchedKeys.add(m[1]);
      mergedLines.push(`${m[1]}: ${userScalars.get(m[1])}`);
    } else {
      mergedLines.push(line);
    }
  }
  // No settings: line found — append user-only scalars at the end.
  if (!inSettingsBlock) {
    for (const [k, v] of userScalars) {
      if (!matchedKeys.has(k)) mergedLines.push(`${k}: ${v}`);
    }
  }

  const body = u.body !== '' ? u.body : d.body;
  return `---\n${mergedLines.join('\n')}\n---\n${body}`;
}

// Merge a shipped BLANK.md / CUE.md / AUDITOR.md. Defaults supplies the
// skeleton (comments + field order + contract-field values); user file
// supplies values for non-contract fields and the body.
//
// Contract fields ALWAYS refresh from defaults — these encode runtime/
// security policy (on-host, sandbox, blankReplace, site scoping) and
// must stay in sync as the shipping schema evolves. Everything else
// (priority, keywords, match, blankStep, blankSuffix, blankFormat,
// classify, description, etc.) is treated as user-customisable.
//
// Body handling: keep user's body if non-empty AND differs from
// defaults — that's where prompt customisations live for word-cue
// CUE.md files. Empty/missing user body → use defaults'.
const SHIPPED_MD_CONTRACT_FIELDS = new Set([
  'on-host', 'not-on-host', 'on-site', 'not-on-site',
  'sandbox', 'blankReplace', 'type', 'name', 'spec',
]);
function mergeShippedMd(defaultsContent, userContent) {
  const split = (text) => {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return { fm: '', body: text };
    return { fm: m[1], body: m[2] };
  };
  const d = split(defaultsContent);
  const u = split(userContent);
  const KEY_RE = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/;

  // Pull user's frontmatter keys (top-level only, skip comments/blanks).
  const userValues = new Map();
  for (const line of u.fm.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith(' ') || line.startsWith('\t')) continue;
    const m = line.match(KEY_RE);
    if (m) userValues.set(m[1], m[2]);
  }

  // Walk defaults frontmatter, substituting user values for non-contract keys.
  const matched = new Set();
  const out = [];
  for (const line of d.fm.split('\n')) {
    const m = !line.startsWith(' ') && !line.startsWith('\t') ? line.match(KEY_RE) : null;
    if (!m) { out.push(line); continue; }
    const key = m[1];
    if (SHIPPED_MD_CONTRACT_FIELDS.has(key)) {
      out.push(line);  // contract field — always from defaults
    } else if (userValues.has(key)) {
      out.push(`${key}: ${userValues.get(key)}`);
      matched.add(key);
    } else {
      out.push(line);
    }
  }
  // Append user-only keys (present in user, not in defaults). Contract
  // fields are EXCLUDED: when defaults omits a contract field (e.g.
  // `on-host` for an auto-detected non-chrome blank), the runtime's
  // auto-detection is the source of truth. A user file carrying a stale
  // contract value (typical drift: `on-host: codex` after codex was
  // retired) gets dropped here, restoring defaults' policy.
  const extras = [];
  for (const [k, v] of userValues) {
    if (matched.has(k) || defaultsHasTopLevelKey(d.fm, k)) continue;
    if (SHIPPED_MD_CONTRACT_FIELDS.has(k)) continue;
    extras.push(`${k}: ${v}`);
  }
  if (extras.length > 0) {
    out.push('# ── User-only fields (preserved by shipped-md refresh) ──');
    out.push(...extras);
  }

  const mergedFm = out.join('\n');
  // Body: prefer user's when it carries content (LLM prompt for CUE.md, etc.).
  const userBodyTrim = u.body.trim();
  const defaultsBodyTrim = d.body.trim();
  const body = userBodyTrim !== '' ? u.body : d.body;
  // Idempotency: if user already had every default key + same contract values
  // + same body shape, we want to return the user file verbatim. Hard to do
  // perfectly without re-parsing, but the line-walk above is deterministic so
  // subsequent runs produce stable output.
  return `---\n${mergedFm}\n---\n${body}`;
}
function defaultsHasTopLevelKey(fm, key) {
  // Keys are [a-zA-Z][a-zA-Z0-9_-]* — no regex metachars need escaping.
  const re = new RegExp(`^${key}:`, 'm');
  return re.test(fm);
}

function printHelp() {
  console.log('opencues seed-configs [--project] [--dry-run] [--silent]');
  console.log('');
  console.log('Manage the user-level ~/.cues/ tree. Idempotent + safe to re-run.');
  console.log('');
  console.log('On every invocation:');
  console.log('  1. Seed first-time copies (CUES.md, BLANKS.md, OPENCUES.md, etc.) — never overwrites');
  console.log('  2. Sync library files (.sh/.cs/.ps1) from defaults/{blanks,scripts}/');
  console.log('     — overwrites stale copies but never .md (user content)');
  console.log('  3. Self-heal a 0-byte OPENCUES.md (would otherwise silently break');
  console.log('     "opencues ___" / "config ___" blank-fills on native hosts)');
  console.log('  4. Compile colocated .cs → .exe (WSL only — needs csc.exe)');
  console.log('');
  console.log('  --project    Seed <cwd>/.cues/ instead of ~/.cues/');
  console.log('               (sync/self-heal/compile only run for user scope)');
  console.log('  --dry-run    Print the plan; do not copy or compile anything');
  console.log('  --silent     Suppress non-error output (used when chained from install)');
  console.log('  --help       Show this message');
}

// Test surface — internals exposed for unit testing without re-exporting
// the bare functions at the top level. Keep stable: the tests in
// packages/opencues-runtime/testing/ import via `seedConfigs._test`.
module.exports._test = { mergeOpencuesMd, mergeShippedMd };
