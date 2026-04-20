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

  // Load core's parser + host-compat helpers. opencues.md uses a
  // runtime-side parser (different shape — top-level YAML state, not
  // section-based); for now we just verify opencues.md is readable text.
  let core;
  try {
    core = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/index.js'));
  } catch (err) {
    console.error(`opencues validate: failed to load @opencues/core (have you run \`pnpm build\`?)`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }
  const { parseCuesMd, parseSingleCueMd, inferHostCompat, unknownHostNames } = core;

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

  // Track every word-alts source we see across all search paths so we
  // can report the post-merge default-source picture (rather than per
  // path — what matters is the EFFECTIVE config the runtime sees).
  const wordAltSources = []; // [{file, name, hasMatch, hasKeywords, priority}]

  for (const { label, dir } of searchPaths) {
    if (!fs.existsSync(dir)) {
      warnings.push(`${label} dir does not exist: ${dir}`);
      continue;
    }
    console.log(`Checking ${label}-level: ${dir}`);
    walkConfigDir(dir, label, { parseCuesMd, parseSingleCueMd, inferHostCompat, unknownHostNames }, seen, errors, warnings, wordAltSources);
  }

  // Default-source sanity for word-alts (per the routing rules in
  // docs/features/word-alt-routing.md). Same precedence ConfigLoader
  // applies — folder cues + monolithic merged, project wins over user
  // — already reflected in the collection above.
  checkDefaultSources(wordAltSources, errors, warnings);

  // Report.
  console.log('');
  for (const w of warnings) console.log(`  WARN  ${w}`);
  for (const e of errors)   console.log(`  ERROR ${e}`);

  console.log('');
  console.log(`${errors.length} error(s), ${warnings.length} warning(s).`);
  if (errors.length > 0) process.exit(1);
  if (strict && warnings.length > 0) process.exit(1);
};

function walkConfigDir(dir, label, tools, seen, errors, warnings, wordAltSources) {
  const { parseCuesMd, parseSingleCueMd, inferHostCompat, unknownHostNames } = tools;
  // Helper: record a word-alts source so we can later check the default
  // picture across the whole effective config. Only counts entries that
  // would actually go into the RoutedWordSourceGroup.
  const noteWordAlts = (name, src, file) => {
    if (!wordAltSources) return;
    const parser = src?.parser ?? 'alternatives';
    const scope = src?.scope ?? 'words';
    if (parser !== 'alternatives' || scope !== 'words') return;
    if (src?.enabled === false) return;
    wordAltSources.push({
      file, name,
      hasMatch: !!src?.match,
      hasKeywords: !!src?.keywords,
      priority: src?.priority ?? 50,
    });
  };
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
      // parseCuesMd is forgiving by design — it returns empty
      // frontmatter + sections on garbage rather than throwing. Catch
      // the "looks like the user tried frontmatter but broke it" case:
      // a `---` fence present but nothing extracted.
      const looksLikeFrontmatterAttempt = /^---\s*$/m.test(content);
      const parsedNothing =
        (!parsed?.frontmatter || Object.keys(parsed.frontmatter).length === 0) &&
        (!parsed?.sections || Object.keys(parsed.sections).length === 0) &&
        (!parsed?.promptConfig?.sources || Object.keys(parsed.promptConfig.sources).length === 0);
      if (looksLikeFrontmatterAttempt && parsedNothing) {
        errors.push(`${p}: looks like frontmatter is malformed — nothing parsed`);
      }
      const namesInThisFile = new Set();
      if (parsed && parsed.promptConfig && parsed.promptConfig.sources) {
        for (const [name, src] of Object.entries(parsed.promptConfig.sources)) {
          if (namesInThisFile.has(name)) errors.push(`${p}: duplicate name "${name}" within file`);
          namesInThisFile.add(name);
          seen[kind].set(name, p);
          checkHostCompat(p, name, src, inferHostCompat, unknownHostNames, errors, warnings);
          if (kind === 'cue') noteWordAlts(name, src, p);
        }
      }
      if (parsed && parsed.controls) {
        for (const [name, ctl] of Object.entries(parsed.controls)) {
          seen.control.set(name, p);
          checkHostCompat(p, name, ctl, inferHostCompat, unknownHostNames, errors, warnings);
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
        const folderParsed = parseSingleCueMd(content, path.dirname(cueMd));
        seen[kind].set(entry.name, cueMd); // overrides any monolithic mention; that's intentional
        checkHostCompat(cueMd, entry.name, folderParsed.frontmatter, inferHostCompat, unknownHostNames, errors, warnings);
        if (kind === 'cue') noteWordAlts(entry.name, folderParsed.frontmatter, cueMd);
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

// Default-source sanity for word-alts, per docs/features/word-alt-routing.md:
//
//   - Sources WITHOUT match: AND WITHOUT keywords: are "default" sources.
//     They catch any word that doesn't hit a domain rule.
//   - Sources WITH either rule are "domain" sources.
//
// Two states worth surfacing:
//
//   1. Zero defaults across the merged config. Any word that doesn't
//      match a domain regex/keyword produces no cue → not navigable.
//      That's intentional for some opt-in projects (legal-only, etc.)
//      so we report as INFO not WARN/ERROR.
//
//   2. Multiple defaults at the same priority. The runtime currently
//      first-registered-wins on ties; deterministic but invisible to
//      the user. Surface so authors can pick a winning priority.
function checkDefaultSources(wordAltSources, errors, warnings) {
  if (wordAltSources.length === 0) return; // no word-alts → nothing to say
  // De-dup by source name. ConfigLoader merges across paths (project +
  // user) so the runtime sees one source per name. Without this the
  // validator would emit a false-positive "4 grammar defaults at
  // priority 50" when the user just has the same source seeded at both
  // levels.
  const byName = new Map();
  for (const s of wordAltSources) {
    const cur = byName.get(s.name);
    if (!cur || s.priority > cur.priority) byName.set(s.name, s);
  }
  const merged = [...byName.values()];
  const defaults = merged.filter(s => !s.hasMatch && !s.hasKeywords);
  if (defaults.length === 0) {
    warnings.push(
      'no default word-alt cue source — words that don\'t match any ' +
      `domain rule (match:/keywords:) won't be navigable. ${merged.length} ` +
      'domain source(s) seen. If this is intentional (opt-in project), ignore.'
    );
    return;
  }
  // Group defaults by priority and warn on ties.
  const byPriority = new Map();
  for (const d of defaults) {
    const list = byPriority.get(d.priority) ?? [];
    list.push(d);
    byPriority.set(d.priority, list);
  }
  for (const [priority, list] of byPriority) {
    if (list.length > 1) {
      const names = list.map(d => d.name).join(', ');
      warnings.push(
        `${list.length} default cue sources at priority ${priority}: ${names}. ` +
        'Tiebreak is first-registered-wins; bump one\'s priority to make ' +
        'the choice deterministic.'
      );
    }
  }
}

// Host-compat sanity. Three failure modes worth catching:
//   1. Unknown host name in on-host: / not-on-host: (typo, e.g. "claud-code")
//   2. on-host: [chrome] but the script: extension implies subprocess
//      (auto-detect would say "not chrome" — author probably didn't realise)
//   3. inferHostCompat() resolves to ZERO hosts (effectively disabled)
function checkHostCompat(file, name, src, inferHostCompat, unknownHostNames, errors, warnings) {
  if (!src) return;
  // 1. Typos in explicit lists.
  const onHost = src.onHost ?? src['on-host'];
  const notOnHost = src.notOnHost ?? src['not-on-host'];
  for (const bad of unknownHostNames(onHost)) {
    warnings.push(`${file}: ${name}: unknown host in on-host: "${bad}"`);
  }
  for (const bad of unknownHostNames(notOnHost)) {
    warnings.push(`${file}: ${name}: unknown host in not-on-host: "${bad}"`);
  }
  // 2. Author override likely wrong (script: ./X.sh but on-host: [chrome]).
  const compat = inferHostCompat(src);
  const explicitChrome = compat.source === 'on-host' && compat.hosts.includes('chrome');
  const sub = ['.sh', '.bash', '.ps1', '.bat', '.cmd', '.exe', '.py', '.rb', '.pl'];
  const hasSubprocess = (s) => s && sub.some(e => s.toLowerCase().endsWith(e));
  if (explicitChrome && (hasSubprocess(src.script) || hasSubprocess(src.blankScript))) {
    warnings.push(
      `${file}: ${name}: on-host includes "chrome" but script extension implies a subprocess ` +
      `(${src.script || src.blankScript}). Chrome can't spawn processes — was this intended?`
    );
  }
  // 3. Empty allow-list = entry never runs anywhere.
  if (compat.hosts.length === 0) {
    warnings.push(`${file}: ${name}: host-compat resolves to 0 hosts — this entry will never run`);
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
  console.log('  * Host-compat issues: unknown host names, contradictions, empty allow-list');
}
