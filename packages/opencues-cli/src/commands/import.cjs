// `opencues import <source>` — download a config pack and install it.
//
// Sources:
//   gist:<id>             https://gist.github.com/raw/<id>/<file>
//   github:<user>/<repo>  https://api.github.com/repos/<user>/<repo>/tarball/HEAD
//   github:<u>/<r>#<ref>  same, at a tag/branch/sha
//   https://....tar.gz    raw tarball URL
//   ./local-path/         local dir (for testing your own packs)
//
// Where it lands: ~/.cues/packs/<name>/  (or <cwd>/.cues/packs/<name>/
// with --project). Pack identity preserved for `opencues remove <name>` later.
//
// Safety: imported packs CANNOT contain absolute or traversing script: /
// blankScript: paths. Use --unsafe-allow-scripts to override (for trusted
// packs only).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

module.exports = function importCmd(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  let source = null;
  const dryRun = argv.includes('--dry-run');
  const projectScope = argv.includes('--project');
  const force = argv.includes('--force');
  const allowScripts = argv.includes('--unsafe-allow-scripts');
  let nameOverride = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') { nameOverride = argv[++i]; continue; }
    if (a.startsWith('-')) continue;
    if (!source) source = a;
  }

  if (!source) {
    console.error('opencues import: missing <source>. Examples:');
    console.error('  opencues import gist:abc123');
    console.error('  opencues import github:user/repo');
    console.error('  opencues import https://example.com/pack.tar.gz');
    console.error('  opencues import ./local-pack/');
    process.exit(2);
  }

  const HOME = os.homedir();
  const installRoot = projectScope
    ? path.join(process.cwd(), '.cues', 'packs')
    : path.join(HOME, '.cues', 'packs');

  let resolved;
  try {
    resolved = resolveSource(source);
  } catch (err) {
    console.error(`opencues import: ${err.message}`);
    process.exit(1);
  }
  const packName = nameOverride || resolved.defaultName;
  const target = path.join(installRoot, packName);

  console.log(`Source:  ${source}`);
  console.log(`         → ${resolved.url || resolved.localPath}`);
  console.log(`Target:  ${target}`);
  console.log('');

  if (fs.existsSync(target) && !force) {
    console.error(`opencues import: pack "${packName}" already installed at ${target}`);
    console.error('Pass --force to reinstall, or pick --name <other> for a different pack name.');
    process.exit(1);
  }

  if (dryRun) {
    console.log('[dry-run] Would download, validate, and install above.');
    console.log('[dry-run] Validation step would refuse absolute / traversing script: paths.');
    return;
  }

  // Stage in a temp dir; only move into place after validation passes.
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencues-import-'));
  try {
    if (resolved.localPath) {
      console.log(`Copying from ${resolved.localPath}...`);
      copyDir(resolved.localPath, stageDir);
    } else {
      console.log(`Downloading ${resolved.url}...`);
      const tarballPath = path.join(stageDir, 'pack.tar.gz');
      downloadToFile(resolved.url, tarballPath);
      console.log('Extracting...');
      extractTarGz(tarballPath, stageDir);
      fs.rmSync(tarballPath, { force: true });
      flattenSingleRootDir(stageDir);
    }

    console.log('Validating...');
    const issues = validatePack(stageDir, { allowScripts });
    if (issues.length > 0) {
      console.log('');
      for (const i of issues) console.log(`  ${i.severity.toUpperCase()} ${i.message}`);
      const errors = issues.filter(i => i.severity === 'error');
      if (errors.length > 0) {
        console.error(`\nimport refused: ${errors.length} validation error(s).`);
        console.error('Use --unsafe-allow-scripts if you trust this pack and need its scripts.');
        process.exit(1);
      }
    }

    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(installRoot, { recursive: true });
    fs.renameSync(stageDir, target);

    // Write a meta file so we can list / remove / update later.
    const meta = {
      name: packName,
      source,
      installedAt: new Date().toISOString(),
      scope: projectScope ? 'project' : 'user',
    };
    fs.writeFileSync(path.join(target, '.cues-pack.json'), JSON.stringify(meta, null, 2));

    const summary = summariseContents(target);
    console.log(`\nInstalled pack "${packName}" at ${target}`);
    console.log(`  ${summary.cues} cue(s), ${summary.blanks} blank(s)`);
    console.log('');
    console.log('Note: ConfigLoader does not yet walk packs/<name>/ subfolders automatically');
    console.log('— it will after the next ConfigLoader update. Symlink contents into the');
    console.log('parent .cues/ dir for now if you want them active immediately.');
  } catch (err) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    console.error(`opencues import: ${err.message}`);
    process.exit(1);
  }
};

// --- source resolution ----------------------------------------------------

function resolveSource(source) {
  if (source.startsWith('gist:')) {
    const id = source.slice('gist:'.length);
    // Gist tarball URL via codeload-style endpoint.
    return {
      url: `https://gist.github.com/${id}/archive/HEAD.tar.gz`,
      defaultName: `gist-${id}`,
    };
  }
  if (source.startsWith('github:')) {
    const rest = source.slice('github:'.length);
    const [repo, ref] = rest.split('#');
    const [user, name] = repo.split('/');
    if (!user || !name) throw new Error(`bad github source: github:${rest} (expected user/repo[#ref])`);
    const refPart = ref || 'HEAD';
    return {
      url: `https://api.github.com/repos/${user}/${name}/tarball/${refPart}`,
      defaultName: name,
    };
  }
  if (source.startsWith('https://') || source.startsWith('http://')) {
    const baseName = path.basename(new URL(source).pathname).replace(/\.tar\.gz$|\.tgz$/, '') || 'imported-pack';
    return { url: source, defaultName: baseName };
  }
  if (source.startsWith('./') || source.startsWith('/') || source.startsWith('~')) {
    let p = source;
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    p = path.resolve(p);
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
      throw new Error(`local source not found or not a directory: ${p}`);
    }
    return { localPath: p, defaultName: path.basename(p) };
  }
  throw new Error(`unrecognised source: ${source}`);
}

// --- download + extract ---------------------------------------------------

function downloadToFile(url, dest, redirects = 0) {
  if (redirects > 5) throw new Error('too many redirects');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'opencues-cli', accept: 'application/octet-stream' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadToFile(res.headers.location, dest, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        res.resume();
        return;
      }
      const stream = fs.createWriteStream(dest);
      res.pipe(stream);
      stream.on('finish', () => stream.close(resolve));
      stream.on('error', reject);
    });
    req.on('error', reject);
  }).then(() => undefined);
}

function extractTarGz(tarballPath, destDir) {
  // Shell out to `tar` (POSIX standard; available on every dev machine).
  // -x extract, -z gunzip, -f file, -C cd into.
  const r = spawnSync('tar', ['-xzf', tarballPath, '-C', destDir]);
  if (r.status !== 0) throw new Error(`tar -xzf failed (exit ${r.status}): ${r.stderr?.toString()}`);
}

function flattenSingleRootDir(dir) {
  // GitHub/gist tarballs typically extract to a single root dir like
  // 'user-repo-sha1234/'. Move its contents up one level so our pack
  // dir is not nested.
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    const inner = path.join(dir, entries[0].name);
    for (const child of fs.readdirSync(inner)) {
      fs.renameSync(path.join(inner, child), path.join(dir, child));
    }
    fs.rmdirSync(inner);
  }
}

// --- validation -----------------------------------------------------------

function validatePack(dir, opts) {
  const issues = [];
  walk(dir, (file) => {
    const rel = path.relative(dir, file);
    if (!file.endsWith('.md')) return;
    const content = fs.readFileSync(file, 'utf8');
    // Refuse absolute / traversing script paths unless --unsafe-allow-scripts.
    if (!opts.allowScripts) {
      const m = content.match(/^\s*(?:script|blankScript):\s*(.+)$/m);
      if (m) {
        let p = m[1].trim().replace(/^["']|["']$/g, '');
        if (p.startsWith('/') || p.startsWith('..') || p.includes('..')) {
          issues.push({ severity: 'error', message: `${rel}: refused absolute/traversing script path "${p}"` });
        }
      }
    }
    // Refuse malformed frontmatter (same heuristic as `opencues validate`:
    // a `---` fence is present but nothing could be extracted).
    //
    // File shapes differ:
    //   - top-level cues.md/blanks.md                   → parseCuesMd
    //   - folder-based <kind>/<name>/cue.md             → parseSingleCueMd
    //   - README.md or anything under docs/             → skip (prose)
    const relParts = rel.split(path.sep);
    const basename = path.basename(rel).toLowerCase();
    const isDocOrReadme =
      basename === 'readme.md' ||
      relParts.some(p => p.toLowerCase() === 'docs');
    if (!isDocOrReadme) {
      const hasFence = /^---\s*$/m.test(content);
      if (hasFence) {
        // Per-folder entry: <kind>/<name>/{CUE.md|BLANK.md|cue.md}.
        // Accept the canonical uppercase + lowercase legacy. Comparison
        // is case-insensitive (basename was already lowercased).
        const isFolderBased =
          (basename === 'cue.md' || basename === 'blank.md') &&
          relParts.length >= 3 &&
          ['cues', 'blanks'].includes(relParts[relParts.length - 3]);
        try {
          const core = getCore();
          let parsedNothing;
          if (isFolderBased) {
            const parsed = core.parseSingleCueMd(content);
            parsedNothing =
              (!parsed?.frontmatter || Object.keys(parsed.frontmatter).length === 0);
          } else {
            const parsed = core.parseCuesMd(content);
            parsedNothing =
              (!parsed?.frontmatter || Object.keys(parsed.frontmatter).length === 0) &&
              (!parsed?.sections || Object.keys(parsed.sections).length === 0) &&
              (!parsed?.promptConfig?.sources || Object.keys(parsed.promptConfig.sources).length === 0);
          }
          if (parsedNothing) {
            issues.push({ severity: 'error', message: `${rel}: looks like frontmatter is malformed — nothing parsed` });
          }
        } catch (err) {
          issues.push({ severity: 'error', message: `${rel}: parse failed — ${err.message}` });
        }
      }
    }
  });
  return issues;
}

// Lazy-load core's parsers once per process — validatePack may run on
// tarball-extracted packs in any CWD, so we can't rely on cwd resolution.
let _coreCache = null;
function getCore() {
  if (_coreCache) return _coreCache;
  const corePath = path.resolve(__dirname, '../../../opencues-core/dist/index.js');
  _coreCache = require(corePath);
  return _coreCache;
}

function walk(dir, cb) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, cb);
    else cb(full);
  }
}

function summariseContents(dir) {
  const out = { cues: 0, blanks: 0 };
  for (const sub of ['cues', 'blanks']) {
    const p = path.join(dir, sub);
    if (!fs.existsSync(p)) continue;
    out[sub] = fs.readdirSync(p, { withFileTypes: true }).filter(e => e.isDirectory()).length;
  }
  return out;
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

function printHelp() {
  console.log('opencues import <source> [options]');
  console.log('');
  console.log('Download a community OpenCues config pack and install it under');
  console.log('~/.cues/packs/<name>/ (or <cwd>/.cues/packs/<name>/ with');
  console.log('--project).');
  console.log('');
  console.log('Sources:');
  console.log('  gist:<id>                    GitHub gist (tarball)');
  console.log('  github:<user>/<repo>[#ref]   GitHub repo, optional tag/branch/sha');
  console.log('  https://....tar.gz           raw tarball URL');
  console.log('  ./local-path/                local directory (for testing)');
  console.log('');
  console.log('Flags:');
  console.log('  --name <override>            install as a different pack name');
  console.log('  --project                    install under <cwd>/.cues/ (default: ~/.cues/)');
  console.log('  --force                      overwrite existing pack');
  console.log('  --dry-run                    print plan, do not execute');
  console.log('  --unsafe-allow-scripts       allow absolute/traversing script: paths');
  console.log('                               (default: refuse for safety)');
  console.log('');
  console.log('Examples:');
  console.log('  opencues import gist:abc1234');
  console.log('  opencues import github:user/legal-cues#v1.2');
  console.log('  opencues import ./my-pack/ --project');
}
