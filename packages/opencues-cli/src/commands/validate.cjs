// `opencues validate` — lint .md configs across search paths.
//
// Walks the same search paths ConfigLoader uses, parses every .md, and
// reports issues. Exit 0 on success, 1 on errors.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { tag, bold, dim, fileLink, banner, cliVersion } = require('../lib/style.cjs');

module.exports = function validate(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  console.log(banner({ version: cliVersion(ctx), tagline: 'lint .cues/ configs' }));
  console.log('');
  const projectOnly = argv.includes('--project');
  const userOnly = argv.includes('--user');
  const strict = argv.includes('--strict');

  // Load core's parser + host-compat helpers. OPENCUES.md uses a
  // runtime-side parser (different shape — top-level YAML state, not
  // section-based); for now we just verify OPENCUES.md is readable text.
  let core;
  try {
    core = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/index.js'));
  } catch (err) {
    console.error(`opencues validate: failed to load @opencues/core (have you run \`pnpm build\`?)`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }
  const { parseCuesMd, parseSingleCueMd, inferHostCompat, unknownHostNames, validateEndpoint } = core;

  const HOME = os.homedir();
  const searchPaths = [];
  if (!userOnly) searchPaths.push({ label: 'project', dir: path.join(process.cwd(), '.cues') });
  if (!projectOnly) searchPaths.push({ label: 'user', dir: path.join(HOME, '.cues') });

  const errors = [];
  const warnings = [];
  // Per-kind name → source-file map. Within ONE source (one CUES.md OR
  // one per-folder CUE.md / BLANK.md), duplicates are errors. Across sources (CUES.md
  // + cues/<name>/CUE.md), folder takes precedence — that's the merge
  // contract, not a conflict. So we track names per source file.
  const seen = { cue: new Map(), blank: new Map() };

  // Track every word-cue source we see so we can warn on entries that
  // would be dropped at runtime (no match: / no keywords: → not routable).
  const wordCueSources = []; // [{file, name, hasMatch, hasKeywords, priority}]

  for (const { label, dir } of searchPaths) {
    if (!fs.existsSync(dir)) {
      warnings.push(`${label} dir does not exist: ${dir}`);
      continue;
    }
    console.log(`${bold('Checking')} ${bold(label + '-level')} ${dim(fileLink(dir, dir))}`);
    walkConfigDir(dir, label, { parseCuesMd, parseSingleCueMd, inferHostCompat, unknownHostNames, validateEndpoint }, seen, errors, warnings, wordCueSources);
  }

  // Sources without match: AND keywords: would be dropped silently by
  // RoutedWordSourceGroup at runtime. Surface them so the author can
  // either add a rule or delete the source.
  checkUnroutableWordCues(wordCueSources, warnings);

  // Report.
  console.log('');
  for (const w of warnings) console.log(`  ${tag('warn')} ${w}`);
  for (const e of errors)   console.log(`  ${tag('err')} ${e}`);

  console.log('');
  const summary = `${bold(errors.length)} error(s), ${bold(warnings.length)} warning(s)`;
  if (errors.length === 0 && warnings.length === 0) console.log(`${tag('ok')} ${summary}`);
  else if (errors.length === 0)                     console.log(`${tag('warn')} ${summary}`);
  else                                              console.log(`${tag('err')} ${summary}`);
  if (errors.length > 0) process.exit(1);
  if (strict && warnings.length > 0) process.exit(1);
};

function walkConfigDir(dir, label, tools, seen, errors, warnings, wordCueSources) {
  const { parseCuesMd, parseSingleCueMd, inferHostCompat, unknownHostNames, validateEndpoint } = tools;
  // Helper: record a word-cue source so we can later check that every
  // entry has match:/keywords: (else it gets dropped at runtime).
  //
  // Static-alts cues (LocalCueSource) classify per-word against their
  // JSON `words:` map and don't need match/keywords — they're inert
  // for words not in the map. Detect them by the JSON code-block body
  // and skip the routing check entirely. Without this, the shipped
  // `tips` cue gets a false-positive "would be dropped at runtime"
  // warning.
  const STATIC_ALTS_BODY_RE = /```json\b/;
  const noteWordCue = (name, src, file, content) => {
    if (!wordCueSources) return;
    const parser = src?.parser ?? 'alternatives';
    const scope = src?.scope ?? 'words';
    if (parser !== 'alternatives' || scope !== 'words') return;
    if (src?.enabled === false) return;
    if (content && STATIC_ALTS_BODY_RE.test(content)) return;
    wordCueSources.push({
      file, name,
      hasMatch: !!src?.match,
      hasKeywords: !!src?.keywords,
      priority: src?.priority ?? 50,
    });
  };
  // Top-level .md files (CUES.md, BLANKS.md). Duplicates WITHIN one
  // file = error. OPENCUES.md uses a different schema; we just check
  // it's readable.
  for (const [filename, kind] of [
    ['CUES.md',   'cue'],
    ['BLANKS.md', 'blank'],
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
          checkEndpoint(p, name, src, validateEndpoint, errors, warnings);
          if (kind === 'cue') noteWordCue(name, src, p);
        }
      }
      if (parsed && parsed.blanks) {
        for (const [name, blk] of Object.entries(parsed.blanks)) {
          seen.blank.set(name, p);
          checkHostCompat(p, name, blk, inferHostCompat, unknownHostNames, errors, warnings);
          checkEndpoint(p, name, blk, validateEndpoint, errors, warnings);
        }
      }
    } catch (err) {
      errors.push(`${p}: parse failed — ${err.message}`);
    }
  }

  // OPENCUES.md — readable check only. Tolerate the lowercase legacy
  // name (seed-configs migrates these eventually) so half-migrated
  // dirs don't generate spurious errors.
  for (const settingsName of ['OPENCUES.md', 'opencues.md']) {
    const settingsPath = path.join(dir, settingsName);
    if (!fs.existsSync(settingsPath)) continue;
    try { fs.readFileSync(settingsPath, 'utf8'); }
    catch (err) { errors.push(`${settingsPath}: read failed — ${err.message}`); }
    break;
  }

  // Folder discoveries: .cues/{cues,blanks}/<name>/{CUE.md|BLANK.md}.
  // Folder name IS the cue/blank name. Per the open standard the
  // per-folder file is uppercase + type-specific (CUE.md inside cues/,
  // BLANK.md inside blanks/). Tolerate lowercase + legacy cue.md so
  // half-migrated user dirs don't get drowned in spurious warnings.
  // Within the same dir filesystems prevent duplicate folder names;
  // folder + monolithic of the same name is fine — folder overrides.
  for (const [subdir, kind, primaryFile] of [
    ['cues',   'cue',   'CUE.md'],
    ['blanks', 'blank', 'BLANK.md'],
  ]) {
    const sub = path.join(dir, subdir);
    if (!fs.existsSync(sub) || !fs.statSync(sub).isDirectory()) continue;
    for (const entry of fs.readdirSync(sub, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidates = [primaryFile, primaryFile.toLowerCase(), 'cue.md'];
      const cueMd = candidates
        .map(f => path.join(sub, entry.name, f))
        .find(p => fs.existsSync(p));
      if (!cueMd) {
        warnings.push(`${sub}/${entry.name}/ has no ${primaryFile}`);
        continue;
      }
      try {
        const content = fs.readFileSync(cueMd, 'utf8');
        const folderParsed = parseSingleCueMd(content, path.dirname(cueMd));
        seen[kind].set(entry.name, cueMd); // overrides any monolithic mention; that's intentional
        checkHostCompat(cueMd, entry.name, folderParsed.frontmatter, inferHostCompat, unknownHostNames, errors, warnings, content);
        checkEndpoint(cueMd, entry.name, folderParsed.frontmatter, validateEndpoint, errors, warnings);
        if (kind === 'cue') noteWordCue(entry.name, folderParsed.frontmatter, cueMd, content);
        // Sanity: if the per-folder file declares a script, check it exists + executable.
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
        // Sandbox declaration hygiene: a blankScript: blank with no
        // explicit `sandbox:` declaration is ambiguous — author may
        // have intended strict isolation but forgot to opt in, OR
        // may need filesystem access (volume / brightness) and just
        // forgot to declare 'off'. Encourage explicit.
        const fm = folderParsed.frontmatter || {};
        if (fm.blankScript && fm.sandbox === undefined) {
          warnings.push(
            `${cueMd}: blankScript declared without sandbox: setting. ` +
            `Add \`sandbox: strict\` (recommended — see docs/architecture/sandbox.md) ` +
            `OR \`sandbox: off\` with a rationale comment for blanks that need ` +
            `filesystem / network access outside the runtime sandbox.`,
          );
        }
        // User-shipped JS blank sanity: if impl: is a relative path,
        // check that the JS file exists and that the blank declared
        // at least one capability (zero capabilities is allowed but
        // usually a sign the author forgot to enable network/etc.).
        const implMatch = content.match(/^\s*impl:\s*(.+)$/m);
        if (implMatch) {
          const implRaw = implMatch[1].trim().replace(/^["']|["']$/g, '');
          if (implRaw.startsWith('./') || implRaw.startsWith('../')) {
            const jsPath = path.join(path.dirname(cueMd), implRaw);
            if (!fs.existsSync(jsPath)) {
              errors.push(`${cueMd}: impl: points to ${jsPath} which does not exist`);
            }
            const fm = folderParsed.frontmatter || {};
            const hasCap = (fm.userBlankNetwork && fm.userBlankNetwork.length)
              || fm.userBlankLlm || fm.userBlankStorage;
            if (!hasCap) {
              warnings.push(
                `${cueMd}: user-shipped JS blank with no capabilities declared — ` +
                `the blank can compute and log but can't fetch / call LLM / persist state. ` +
                `Add \`network: [host1, host2]\`, \`llm: <provider>\`, or \`storage: <namespace>\` to enable.`,
              );
            }
            checkUserBlankCapabilities(cueMd, fm, jsPath, errors, warnings);
          }
        }
      } catch (err) {
        errors.push(`${cueMd}: parse failed — ${err.message}`);
      }
    }
  }
}

// Word-cue sources without match: AND keywords: would be dropped silently
// by RoutedWordSourceGroup at runtime. Surface them so the author can
// either declare a rule or remove the source.
function checkUnroutableWordCues(wordCueSources, warnings) {
  if (wordCueSources.length === 0) return;
  // De-dup by source name (ConfigLoader merges across paths).
  const byName = new Map();
  for (const s of wordCueSources) {
    const cur = byName.get(s.name);
    if (!cur || s.priority > cur.priority) byName.set(s.name, s);
  }
  for (const s of byName.values()) {
    if (!s.hasMatch && !s.hasKeywords) {
      warnings.push(
        `${s.file}: word-cue source "${s.name}" has neither match: nor keywords: — ` +
        `it would be dropped at runtime. Add an explicit match/keywords (or use \`match: .*\`).`
      );
    }
  }
}

// User-blank capability hygiene. Three classes of mistake we catch
// at validate time so the author doesn't discover them at load time:
//
//   1. Orphan binding: secret-hosts.<NAME> entry for a NAME not in
//      secrets: [...] — the binding has no value to enforce and is
//      almost always a typo.
//   2. Binding outside network allow-list: secret-hosts.<NAME>
//      lists a host that isn't in network: [...]. ctx.fetch would
//      refuse the request anyway (hostname not allowed); the binding
//      is unreachable.
//   3. Unused secret: secrets: declares <NAME> but the JS source
//      never references ctx.secrets.<NAME> / ctx.secrets[<NAME>] /
//      destructures it. Best-effort substring scan; false positives
//      possible (dynamic key names) so this is a warning, not error.
function checkUserBlankCapabilities(cueMd, fm, jsPath, errors, warnings) {
  const secrets = fm.userBlankSecrets || [];
  const bindings = fm.userBlankSecretBindings || {};
  const network = fm.userBlankNetwork || [];
  const netLower = new Set(network.map(h => h.toLowerCase()));
  const declaredNames = new Set(secrets);

  // 1. Orphan bindings — secret-hosts.X without secrets: [..., X, ...].
  for (const name of Object.keys(bindings)) {
    if (!declaredNames.has(name)) {
      warnings.push(
        `${cueMd}: secret-hosts.${name} declared but "${name}" is not in secrets: [...]. ` +
        `Add to secrets: or remove the binding.`,
      );
    }
  }

  // 2. Binding hosts not in network: allow-list.
  for (const [name, hosts] of Object.entries(bindings)) {
    if (!Array.isArray(hosts)) continue;
    for (const h of hosts) {
      if (!netLower.has(String(h).toLowerCase())) {
        warnings.push(
          `${cueMd}: secret-hosts.${name} lists "${h}" which is not in network: [...]. ` +
          `ctx.fetch refuses unlisted hosts anyway — add "${h}" to network: or drop the binding.`,
        );
      }
    }
  }

  // 3. Unused secret declarations — secrets: [X] but no ctx.secrets.X
  //    anywhere in the JS source. Substring scan is good enough; the
  //    failure mode of a false positive is "warn about a real use" not
  //    "miss an unsafe one".
  if (secrets.length > 0 && fs.existsSync(jsPath)) {
    let src = '';
    try { src = fs.readFileSync(jsPath, 'utf8'); } catch { /* */ }
    for (const name of secrets) {
      // Match ctx.secrets.NAME, ctx.secrets["NAME"], ctx.secrets['NAME'],
      // and destructured `const { NAME } = ctx.secrets`.
      const dot = new RegExp(`\\bctx\\.secrets\\.${name}\\b`).test(src);
      const bracket = new RegExp(`\\bctx\\.secrets\\[\\s*['"]${name}['"]\\s*\\]`).test(src);
      const destruct = new RegExp(`\\b${name}\\b`).test(src) && /ctx\.secrets/.test(src);
      if (!dot && !bracket && !destruct) {
        warnings.push(
          `${cueMd}: secrets: [${name}] declared but ctx.secrets.${name} doesn't appear in ${path.basename(jsPath)}. ` +
          `Remove the declaration or use the secret.`,
        );
      }
    }
  }
}

// Endpoint allow-list sanity. A cue/blank/auditor's frontmatter can
// specify provider: + endpoint:; a malicious / typo'd endpoint would
// route the user's draft (used as prompt context) to an attacker
// server. validateEndpoint() classifies the URL as default / stock /
// custom / invalid; we surface anything that isn't "default" or
// "stock" as a warning so authors verify the URL before installing.
function checkEndpoint(file, name, src, validateEndpoint, errors, warnings) {
  if (!src || !validateEndpoint) return;
  const provider = src.provider;
  const endpoint = src.endpoint;
  if (!provider && !endpoint) return;
  const r = validateEndpoint(provider, endpoint);
  if (!r.ok) {
    errors.push(`${file}: ${name}: ${r.warning}`);
    return;
  }
  if (r.kind === 'custom') {
    warnings.push(`${file}: ${name}: ${r.warning}`);
  }
}

// Host-compat sanity. Three failure modes worth catching:
//   1. Unknown host name in on-host: / not-on-host: (typo, e.g. "claud-code")
//   2. inferHostCompat() resolves to ZERO hosts (effectively disabled)
function checkHostCompat(file, name, src, inferHostCompat, unknownHostNames, errors, warnings, _fileContent) {
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
  // 2. Empty allow-list = entry never runs anywhere.
  const compat = inferHostCompat(src);
  if (compat.hosts.length === 0) {
    warnings.push(`${file}: ${name}: host-compat resolves to 0 hosts — this entry will never run`);
  }
}

function printHelp() {
  console.log('opencues validate [--project] [--user] [--strict]');
  console.log('');
  console.log('Walk the .cues/ search paths, parse every .md, report issues.');
  console.log('Exit 0 on success, 1 on errors (or warnings with --strict).');
  console.log('');
  console.log('  --project    Only check <cwd>/.cues/');
  console.log('  --user       Only check ~/.cues/');
  console.log('  --strict     Treat warnings as errors');
  console.log('  --help       Show this message');
  console.log('');
  console.log('Detects:');
  console.log('  * Frontmatter parse errors (with file path)');
  console.log('  * Duplicate cue/blank names within a path');
  console.log('  * script: / blankScript: paths that don\'t exist or aren\'t executable');
  console.log('  * Empty cue folders (no CUE.md / BLANK.md inside)');
  console.log('  * Host-compat issues: unknown host names, contradictions, empty allow-list');
  console.log('  * Endpoint security: unknown provider:, invalid URL, custom endpoint that');
  console.log('    overrides the stock provider endpoint (warned, not errored)');
  console.log('  * User-blank capability hygiene: orphan secret-hosts bindings,');
  console.log('    bindings pointing outside network: allow-list, unused secrets:');
}
