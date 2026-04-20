// `opencues validate` — lint .md configs across search paths.
//
// Walks the same search paths ConfigLoader uses, parses every .md, and
// reports issues. Exit 0 on success, 1 on errors.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

module.exports = function validate(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const projectOnly = argv.includes('--project');
  const userOnly = argv.includes('--user');
  const strict = argv.includes('--strict');

  // Load core's parser. opencues.md uses a runtime-side parser (different
  // shape — top-level YAML state, not section-based); for now we just
  // verify opencues.md is readable text.
  let parseCuesMd;
  try {
    const core = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/index.js'));
    parseCuesMd = core.parseCuesMd;
  } catch (err) {
    console.error(`opencues validate: failed to load @opencues/core (have you run \`pnpm build\`?)`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }

  const HOME = os.homedir();
  const searchPaths = [];
  if (!userOnly) searchPaths.push({ label: 'project', dir: path.join(process.cwd(), '.opencues') });
  if (!projectOnly) searchPaths.push({ label: 'user', dir: path.join(HOME, '.opencues') });

  const errors = [];
  const warnings = [];
  // Per-kind name → source-file map. Within ONE source (one cues.md OR
  // one folder cue.md), duplicates are errors. Across sources (cues.md
  // + cues/<name>/cue.md), folder takes precedence — that's the merge
  // contract, not a conflict. So we track names per source file.
  const seen = { cue: new Map(), blank: new Map(), control: new Map() };

  for (const { label, dir } of searchPaths) {
    if (!fs.existsSync(dir)) {
      warnings.push(`${label} dir does not exist: ${dir}`);
      continue;
    }
    console.log(`Checking ${label}-level: ${dir}`);
    walkConfigDir(dir, label, parseCuesMd, seen, errors, warnings);
  }

  // Report.
  console.log('');
  for (const w of warnings) console.log(`  WARN  ${w}`);
  for (const e of errors)   console.log(`  ERROR ${e}`);

  console.log('');
  console.log(`${errors.length} error(s), ${warnings.length} warning(s).`);
  if (errors.length > 0) process.exit(1);
  if (strict && warnings.length > 0) process.exit(1);
};

function walkConfigDir(dir, label, parseCuesMd, seen, errors, warnings) {
  // Top-level .md files (cues.md, blanks.md, controls.md). Duplicates
  // WITHIN one file = error. opencues.md uses a different schema; we
  // just check it's readable.
  for (const [filename, kind] of [
    ['cues.md',     'cue'],
    ['blanks.md',   'blank'],
    ['controls.md', 'control'],
  ]) {
    const p = path.join(dir, filename);
    if (!fs.existsSync(p)) continue;
    try {
      const content = fs.readFileSync(p, 'utf8');
      const parsed = parseCuesMd(content);
      const namesInThisFile = new Set();
      if (parsed && parsed.promptConfig && parsed.promptConfig.sources) {
        for (const name of Object.keys(parsed.promptConfig.sources)) {
          if (namesInThisFile.has(name)) errors.push(`${p}: duplicate name "${name}" within file`);
          namesInThisFile.add(name);
          seen[kind].set(name, p);
        }
      }
      if (parsed && parsed.controls) {
        for (const name of Object.keys(parsed.controls)) {
          seen.control.set(name, p);
        }
      }
    } catch (err) {
      errors.push(`${p}: parse failed — ${err.message}`);
    }
  }

  // opencues.md — readable check only.
  const opencuesMdPath = path.join(dir, 'opencues.md');
  if (fs.existsSync(opencuesMdPath)) {
    try { fs.readFileSync(opencuesMdPath, 'utf8'); }
    catch (err) { errors.push(`${opencuesMdPath}: read failed — ${err.message}`); }
  }

  // Folder discoveries: .opencues/{cues,blanks,controls}/<name>/cue.md
  // Folder name IS the cue/blank/control name. Within the same dir,
  // can't have two folders with the same name (filesystem prevents it).
  // Folder + monolithic same name is FINE — folder overrides.
  for (const [subdir, kind] of [['cues', 'cue'], ['blanks', 'blank'], ['controls', 'control']]) {
    const sub = path.join(dir, subdir);
    if (!fs.existsSync(sub) || !fs.statSync(sub).isDirectory()) continue;
    for (const entry of fs.readdirSync(sub, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cueMd = path.join(sub, entry.name, 'cue.md');
      if (!fs.existsSync(cueMd)) {
        warnings.push(`${sub}/${entry.name}/ has no cue.md`);
        continue;
      }
      try {
        const content = fs.readFileSync(cueMd, 'utf8');
        parseCuesMd(content);
        seen[kind].set(entry.name, cueMd); // overrides any monolithic mention; that's intentional
        // Sanity: if cue.md declares a script, check it exists + executable.
        const scriptMatch = content.match(/^\s*(?:script|blankScript):\s*(.+)$/m);
        if (scriptMatch) {
          let scriptPath = scriptMatch[1].trim().replace(/^["']|["']$/g, '');
          if (scriptPath.startsWith('./')) scriptPath = path.join(path.dirname(cueMd), scriptPath);
          if (!fs.existsSync(scriptPath)) {
            errors.push(`${cueMd}: script not found at ${scriptPath}`);
          } else {
            try {
              const stat = fs.statSync(scriptPath);
              if (!(stat.mode & 0o111)) {
                warnings.push(`${cueMd}: script ${scriptPath} is not executable (chmod +x)`);
              }
            } catch { /* ignore */ }
          }
        }
      } catch (err) {
        errors.push(`${cueMd}: parse failed — ${err.message}`);
      }
    }
  }
}

function printHelp() {
  console.log('opencues validate [--project] [--user] [--strict]');
  console.log('');
  console.log('Walk the .opencues/ search paths, parse every .md, report issues.');
  console.log('Exit 0 on success, 1 on errors (or warnings with --strict).');
  console.log('');
  console.log('  --project    Only check <cwd>/.opencues/');
  console.log('  --user       Only check ~/.opencues/');
  console.log('  --strict     Treat warnings as errors');
  console.log('  --help       Show this message');
  console.log('');
  console.log('Detects:');
  console.log('  * Frontmatter parse errors (with file path)');
  console.log('  * Duplicate cue/blank/control names within a path');
  console.log('  * script: / blankScript: paths that don\'t exist or aren\'t executable');
  console.log('  * Empty cue folders (no cue.md inside)');
}
