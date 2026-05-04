// `opencues sync <host>` — push the local .cues/ configs into a
// host that doesn't read the filesystem on its own.
//
// Today this only matters for chrome (browser content scripts can't
// read ~/.cues/). CC/OC have native ConfigLoader hot-reload
// and don't need a sync step.
//
// ── Chrome source discovery ──────────────────────────────────────────
// Chrome is a global browser extension — it isn't "in" a project, has
// no cwd, and runs across every tab. So `sync chrome` defaults to
// user-level ONLY, ignoring whatever directory you happened to run it
// from. Projects that want their configs bundled must opt in:
//
//   1. $OPENCUES_HOME if set          (env override — single source)
//   2. ~/.cues/                   (user-level, default)
//   3. + --include <path> (repeatable, highest priority → wins merges)
//   4. + --project for <cwd>/.cues (same precedence as --include)
//
// Override the whole chain with --pack <name> or --source <path>.
//
// Filter: entries whose host-compat (auto-detected from script:
// extension or declared via on-host:/not-on-host: frontmatter) excludes
// chrome are dropped. See docs/features/host-compat.md.
// Rationale: docs/features/chrome-sync.md.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const HOSTS = ['chrome'];   // sync is chrome-only today

module.exports = function sync(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  let host = null;
  const flags = { project: false, dryRun: false, watch: false, wsl: false };
  const includes = [];
  let pack = null;
  let source = null;
  let target = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') flags.project = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--watch') flags.watch = true;
    else if (a === '--wsl') flags.wsl = true;
    else if (a === '--include') includes.push(argv[++i]);
    else if (a === '--pack') pack = argv[++i];
    else if (a === '--source') source = argv[++i];
    else if (a === '--target') target = argv[++i];
    else if (!a.startsWith('-') && !host) host = a;
  }

  if (!host) {
    console.error(`opencues sync: missing <host>. Hosts: ${HOSTS.join(', ')}`);
    console.error('Run `opencues sync --help` for details.\n');
    process.exit(2);
  }
  if (!HOSTS.includes(host)) {
    console.error(`opencues sync: unsupported host "${host}". Supported today: ${HOSTS.join(', ')}`);
    console.error('CC/OC hot-reload natively from ~/.cues/ — no sync needed.');
    process.exit(2);
  }

  const opts = { flags, includes, pack, source, target };
  if (flags.watch) {
    syncChromeWatch(opts, ctx);
    return;
  }
  syncChrome(opts, ctx);
};

// Run an initial sync, then watch every source dir for changes and
// re-sync on edits. Debounced to coalesce burst writes (e.g. editor
// save). Exits cleanly on SIGINT.
function syncChromeWatch(opts, ctx) {
  syncChrome(opts, ctx);
  const sources = resolveSources(opts);
  if (sources.length === 0) process.exit(0);

  console.log('');
  console.log('Watching for changes (Ctrl+C to stop):');
  for (const s of sources) console.log(`  ${s.dir}`);
  console.log('');

  const DEBOUNCE_MS = 250;
  let pending = false;
  let timer = null;
  const trigger = (reason) => {
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!pending) return;
      pending = false;
      const ts = new Date().toTimeString().slice(0, 8);
      process.stdout.write(`[${ts}] re-syncing (${reason}) ... `);
      try {
        // Re-resolve sources each time — handles new pack dirs etc.
        const distConfigs = path.join(ctx.REPO_ROOT, 'integrations', 'chrome', 'dist', 'configs');
        const before = readVersion(distConfigs);
        syncChromeQuiet(opts, ctx);
        const after = readVersion(distConfigs);
        process.stdout.write(after !== before ? `version ${after}\n` : `no changes\n`);
      } catch (err) {
        process.stdout.write(`failed: ${err.message}\n`);
      }
    }, DEBOUNCE_MS);
  };

  const watchers = [];
  for (const s of sources) {
    if (!fs.existsSync(s.dir)) continue;
    try {
      const w = fs.watch(s.dir, { recursive: true }, (event, filename) => {
        if (!filename) return;
        // Ignore noise: editor swap files, dotfiles other than the
        // ones we'd actually sync.
        if (filename.includes('~') || filename.endsWith('.swp') || filename.endsWith('.tmp')) return;
        trigger(filename);
      });
      watchers.push(w);
    } catch (err) {
      console.error(`  WARN: couldn't watch ${s.dir}: ${err.message}`);
    }
  }

  if (watchers.length === 0) {
    console.error('opencues sync chrome --watch: no watchable sources. Exiting.');
    process.exit(1);
  }

  process.on('SIGINT', () => {
    console.log('\nStopping watcher.');
    for (const w of watchers) try { w.close(); } catch { /* ignore */ }
    process.exit(0);
  });
}

// Same as syncChrome but suppresses the per-file summary chatter —
// for the watch loop where the per-event line is already concise.
function syncChromeQuiet(opts, ctx) {
  const orig = console.log;
  console.log = () => {};
  try { syncChrome(opts, ctx); }
  finally { console.log = orig; }
}

function readVersion(distConfigs) {
  try { return fs.readFileSync(path.join(distConfigs, '.version'), 'utf8').trim(); }
  catch { return ''; }
}

function syncChrome({ flags, includes, pack, source, target }, ctx) {
  const core = loadCore(ctx);
  const sources = resolveSources({ flags, includes, pack, source });
  if (sources.length === 0) {
    console.error('opencues sync chrome: no sources resolved. ~/.cues/ doesn\'t exist.');
    console.error('Try --include <path>, --project, --pack <name>, or --source <path>.');
    process.exit(1);
  }

  // Resolve where to write. Order: --target > --wsl > in-repo dist.
  const repoConfigs = path.join(ctx.REPO_ROOT, 'integrations', 'chrome', 'dist', 'configs');
  let extraTarget = null;
  if (target) extraTarget = path.resolve(target, 'dist', 'configs');
  else if (flags.wsl) {
    const wslPath = resolveWslDeployPath();
    if (!wslPath) {
      console.error('--wsl requires running under WSL with /mnt/c/ accessible.');
      console.error('Use --target <chrome-install-path> for a non-WSL chrome install.');
      process.exit(1);
    }
    extraTarget = path.join(wslPath, 'dist', 'configs');
  }
  const distConfigs = repoConfigs;

  console.log(`Syncing to ${distConfigs}/`);
  for (const s of sources) console.log(`  source: ${s.label.padEnd(8)} ${s.dir}`);
  console.log('');

  // Collect every relevant file across sources, lower-priority first.
  // Higher-priority overlays — same-name folders / files overwrite.
  const plan = [];
  let dropped = 0;
  for (const s of sources) {
    walkSource(s.dir, core, (entry) => {
      if (!entry.compat.hosts.includes('chrome')) {
        dropped++;
        return;
      }
      plan.push({ src: entry.absPath, dst: path.join(distConfigs, entry.relPath) });
    });
  }

  // Resolve same-relPath collisions by keeping the LAST occurrence
  // (sources are ordered low-to-high priority).
  const byDst = new Map();
  for (const p of plan) byDst.set(p.dst, p);
  const finalPlan = [...byDst.values()];

  if (flags.dryRun) {
    console.log(`[dry-run] Would copy ${finalPlan.length} file(s) (skip ${dropped} non-chrome):`);
    for (const p of finalPlan) console.log(`  ${path.relative(distConfigs, p.dst).padEnd(40)} ← ${p.src}`);
    return;
  }

  // Wipe existing dist/configs/ to ensure removed files don't linger.
  if (fs.existsSync(distConfigs)) fs.rmSync(distConfigs, { recursive: true, force: true });
  fs.mkdirSync(distConfigs, { recursive: true });

  let copied = 0;
  const summary = { cue: 0, blank: 0 };
  for (const p of finalPlan) {
    fs.mkdirSync(path.dirname(p.dst), { recursive: true });
    fs.copyFileSync(p.src, p.dst);
    copied++;
    // Categorise for the summary line.
    const rel = path.relative(distConfigs, p.dst);
    if (rel.startsWith('cues') || rel === 'cues.md') summary.cue++;
    else if (rel.startsWith('blanks') || rel === 'blanks.md') summary.blank++;
  }

  // Write index.json so the chrome extension can enumerate what's in
  // the bundle (chrome.runtime.getURL doesn't support directory listing).
  writeIndexJson(distConfigs);

  // Bump .version so the extension can detect changes via polling.
  // Use content hash to avoid re-triggering on no-op syncs.
  const versionPath = path.join(distConfigs, '.version');
  fs.writeFileSync(versionPath, computeVersion(distConfigs));

  console.log(`Synced ${copied} file(s):`);
  console.log(`  ${summary.cue} cue dir(s)/file(s)`);
  console.log(`  ${summary.blank} blank dir(s)/file(s)`);
  if (dropped > 0) {
    console.log(`Skipped ${dropped} entry(ies) flagged as non-chrome (see opencues list for hosts).`);
  }
  console.log(`Version: ${fs.readFileSync(versionPath, 'utf8').trim()}`);

  // Mirror to the deploy target if --wsl / --target was passed. The
  // chrome extension running from <target>/dist/ reads dist/configs/
  // via chrome.runtime.getURL — so the mirror has to be 1:1.
  if (extraTarget) {
    if (fs.existsSync(extraTarget)) fs.rmSync(extraTarget, { recursive: true, force: true });
    fs.mkdirSync(extraTarget, { recursive: true });
    copyDirSync(distConfigs, extraTarget);
    console.log(`Mirrored to ${toWindowsPathIfPossible(extraTarget)}`);
  }
}

function copyDirSync(src, dst) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyDirSync(s, d); }
    else fs.copyFileSync(s, d);
  }
}

// Same WSL detection + Windows username + path used by `opencues
// install chrome --wsl` (integrations/chrome/bin/install.cjs).
function resolveWslDeployPath() {
  if (!isWsl()) return null;
  const probe = require('node:child_process').spawnSync('cmd.exe', ['/c', 'echo %USERNAME%'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (probe.status !== 0) return null;
  const winUser = String(probe.stdout).trim().replace(/\r$/, '');
  if (!winUser) return null;
  return `/mnt/c/Users/${winUser}/AppData/Local/opencues-chrome`;
}
function isWsl() {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try { return /microsoft|wsl/i.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8')); }
  catch { return false; }
}

// Display-only: /mnt/c/Foo/Bar → C:\Foo\Bar so users see the path the
// same way Chrome and File Explorer do. NEVER use the result for
// filesystem ops — Node on Linux can't resolve C:\ paths. Mirror of
// integrations/chrome/bin/install.cjs's helper.
function toWindowsPathIfPossible(p) {
  if (!/^\/mnt\/[a-z]\//i.test(p)) return p;
  const probe = require('node:child_process').spawnSync('wslpath', ['-w', p], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (probe.status === 0) {
    const out = String(probe.stdout).trim();
    if (out) return out;
  }
  const m = p.match(/^\/mnt\/([a-z])\/(.*)$/i);
  return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}` : p;
}

// Resolve which .cues/ dirs to bundle for chrome.
//
// Chrome has no cwd — it's a browser extension running across every
// tab. So sync chrome deliberately DOES NOT inherit the
// "user + <cwd>/.cues" model the native hosts use. It defaults to
// user-level only; projects are opted in explicitly via --include /
// --project / --pack / --source.
//
// Precedence (low → high; later overlays earlier on same-name files):
//   1. $OPENCUES_HOME  (env override — if set, becomes the sole source)
//   2. ~/.cues      (user-level, always first unless overridden)
//   3. each --include <path> in the order given
//   4. --project        (pins to <cwd>/.cues; highest project priority)
//
// --source <path> and --pack <name> SHORT-CIRCUIT everything above and
// become the sole source. Useful for testing a single pack in isolation.
function resolveSources({ flags, includes, pack, source }) {
  if (source) {
    const abs = path.resolve(source);
    return [{ label: 'custom', dir: abs }];
  }
  if (pack) {
    const HOME = os.homedir();
    const candidates = [
      path.join(process.cwd(), '.cues', 'packs', pack),
      path.join(HOME, '.cues', 'packs', pack),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) {
      console.error(`opencues sync chrome: pack "${pack}" not found in ${candidates.join(' or ')}`);
      process.exit(1);
    }
    return [{ label: 'pack', dir: found }];
  }
  const sources = [];
  const HOME = os.homedir();
  if (process.env.OPENCUES_HOME) {
    sources.push({ label: 'env', dir: process.env.OPENCUES_HOME });
  } else {
    const userDir = path.join(HOME, '.cues');
    if (fs.existsSync(userDir)) sources.push({ label: 'user', dir: userDir });
  }
  if (includes && includes.length) {
    for (const inc of includes) {
      const abs = path.resolve(inc);
      if (!fs.existsSync(abs)) {
        console.error(`opencues sync chrome: --include path not found: ${abs}`);
        process.exit(1);
      }
      sources.push({ label: 'include', dir: abs });
    }
  }
  if (flags.project) {
    const projectDir = path.join(process.cwd(), '.cues');
    if (fs.existsSync(projectDir)) sources.push({ label: 'project', dir: projectDir });
  }
  return sources;
}

// Walk a single .cues/ dir, calling cb(entry) for each chrome-relevant
// file. entry = { absPath, relPath, compat }.
function walkSource(dir, core, cb) {
  const { parseCuesMd, parseSingleCueMd, inferHostCompat } = core;

  // Top-level files: cues.md / blanks.md. These are monolithic —
  // host-compat applies per-section, so we either include the whole
  // file or rebuild it from the chrome-compatible subset.
  // Today: include whole file if ANY section is chrome-compatible.
  // Folder-based configs (next loop) get per-entry filtering.
  for (const filename of ['cues.md', 'blanks.md']) {
    const p = path.join(dir, filename);
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = parseCuesMd(fs.readFileSync(p, 'utf8'));
      const sources = (parsed?.promptConfig?.sources) || {};
      const blanks = parsed?.blanks || {};
      const all = [...Object.values(sources), ...Object.values(blanks)];
      const hasChromeCompat = all.length === 0 ||
        all.some(e => inferHostCompat(e || {}).hosts.includes('chrome'));
      if (hasChromeCompat) {
        cb({ absPath: p, relPath: filename, compat: { hosts: ['chrome'] } });
      }
    } catch { /* skip on parse error */ }
  }

  // Folder-based: cues/<name>/cue.md, blanks/<name>/cue.md
  // Per-entry compat filter; copy the WHOLE folder when included.
  for (const subdir of ['cues', 'blanks']) {
    const sub = path.join(dir, subdir);
    if (!fs.existsSync(sub) || !fs.statSync(sub).isDirectory()) continue;
    for (const entry of fs.readdirSync(sub, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folderPath = path.join(sub, entry.name);
      const cueMd = path.join(folderPath, 'cue.md');
      if (!fs.existsSync(cueMd)) continue;
      try {
        const parsed = parseSingleCueMd(fs.readFileSync(cueMd, 'utf8'), folderPath);
        const compat = inferHostCompat(parsed.frontmatter || {});
        if (!compat.hosts.includes('chrome')) {
          // Still emit ONE entry so the caller can count it as dropped.
          // Don't walk the folder — those files would also be dropped.
          cb({ absPath: cueMd, relPath: path.join(subdir, entry.name, 'cue.md'), compat });
        } else {
          // Walk every file in the folder so colocated assets (README.md,
          // sub-prompts, JSON manifests) come along. Skip script files
          // (they wouldn't run in chrome anyway and just bloat the bundle).
          walkFolder(folderPath, (file) => {
            const isScript = /\.(sh|bash|ps1|bat|cmd|exe|py|rb|pl|cs)$/i.test(file);
            if (isScript) return;
            const rel = path.join(subdir, entry.name, path.relative(folderPath, file));
            cb({ absPath: file, relPath: rel, compat });
          });
        }
      } catch { /* skip on parse error */ }
    }
  }

  // opencues.md is system-wide, runtime-owned — skip from sync entirely.
}

function walkFolder(dir, cb) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFolder(full, cb);
    else cb(full);
  }
}

// Emit configs/index.json listing every synced file. The chrome
// extension's bootstrap reads this on boot to know what to fetch —
// there's no directory-listing API for chrome.runtime.getURL().
function writeIndexJson(distConfigs) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;      // skip .version etc
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else files.push(path.relative(distConfigs, f).split(path.sep).join('/'));
    }
  };
  walk(distConfigs);
  files.sort();
  const payload = { schema: 1, files };
  fs.writeFileSync(path.join(distConfigs, 'index.json'), JSON.stringify(payload, null, 2));
}

function computeVersion(rootDir) {
  // Hash of every relPath + content. Stable across machines so a no-op
  // sync (re-run with same inputs) doesn't bump the version and trigger
  // pointless reloads in the extension.
  const h = crypto.createHash('sha256');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.version') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else files.push(f);
    }
  };
  walk(rootDir);
  files.sort();
  for (const f of files) {
    h.update(path.relative(rootDir, f));
    h.update('\0');
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex').slice(0, 16) + '\n';
}

function loadCore(ctx) {
  try {
    return require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/index.js'));
  } catch (err) {
    console.error('opencues sync: failed to load @opencues/core (run `pnpm build`):', err.message);
    process.exit(1);
  }
}

function printHelp() {
  console.log('opencues sync <host> [options]');
  console.log('');
  console.log('Push your local .cues/ configs into a host that can\'t read the');
  console.log('filesystem on its own (today: chrome). CC/OC hot-reload from');
  console.log('~/.cues/ natively — no sync needed.');
  console.log('');
  console.log('Hosts:');
  console.log('  chrome      Bundle into integrations/chrome/dist/configs/');
  console.log('');
  console.log('Default source:  ~/.cues/ only.');
  console.log('Chrome is a global browser extension with no cwd, so the project-');
  console.log('level (<cwd>/.cues/) discovery used by the native hosts is');
  console.log('deliberately OFF by default. Opt projects in with --include / --project.');
  console.log('');
  console.log('Adding sources (stackable; later overlays earlier on same-name files):');
  console.log('  --include <path>   Bundle this extra .cues/ dir (repeatable)');
  console.log('  --project          Also include <cwd>/.cues/ (explicit opt-in)');
  console.log('');
  console.log('Overriding sources (short-circuits the default chain):');
  console.log('  --pack <name>      Sync ONLY ~/.cues/packs/<name>/ (or <cwd>/...)');
  console.log('  --source <path>    Sync ONLY the given directory');
  console.log('');
  console.log('Flags:');
  console.log('  --watch              Re-sync on filesystem change (loop, Ctrl+C to stop)');
  console.log('  --dry-run            Print plan; do not copy');
  console.log('  --target <path>      Also mirror dist/configs/ to <path>/dist/configs/');
  console.log('                       (the chrome install dir — `opencues which` shows it)');
  console.log('  --wsl                Mirror to the WSL Windows-side install location');
  console.log('                       (/mnt/c/Users/<u>/AppData/Local/opencues-chrome/)');
  console.log('  --help               Show this message');
  console.log('');
  console.log('Filter: entries with `not-on-host: chrome` (or auto-detected as');
  console.log('subprocess-only via .sh / .ps1 / etc. script extensions) are skipped.');
  console.log('See docs/features/host-compat.md for the full spec.');
  console.log('');
  console.log('Examples:');
  console.log('  opencues sync chrome --wsl');
  console.log('    # user-level only, mirror to Windows-side install (typical)');
  console.log('  opencues sync chrome --include ~/work/repo-a/.cues --wsl');
  console.log('    # user + one project');
  console.log('  opencues sync chrome --project --wsl');
  console.log('    # user + whatever project dir you\'re in right now');
  console.log('  opencues sync chrome --pack demo-pack --wsl');
  console.log('    # just that pack, nothing else');
  console.log('  opencues sync chrome --dry-run');
  console.log('    # preview the plan');
  console.log('  opencues sync chrome --include ~/opencues/.cues --wsl --watch');
  console.log('    # long-running watcher: stays on this explicit path list');
  console.log('    # regardless of where your shell cwd wanders');
}
