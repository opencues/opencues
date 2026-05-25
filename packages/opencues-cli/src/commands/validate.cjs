// `opencues validate` — lint .md configs across search paths.
//
// Walks the same search paths ConfigLoader uses, parses every .md, and
// reports issues tagged with their spec lint-rule codes (per
// spec/core.md § Linting rules). Exit 0 on success, 1 on errors.
//
// Each finding is `{ rule, severity, file, summary }`. Default output is
// human-readable; `--json` emits machine-readable findings for CI / agent
// consumption (e.g. the conformance suite's CLI runner).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { tag, bold, dim, fileLink, banner, cliVersion } = require('../lib/style.cjs');

// Spec version this runtime targets. Anything strictly newer in a file's
// `spec:` frontmatter trips `spec-too-new`. Kept in sync with
// spec/core.md § Status & versioning.
const SUPPORTED_SPEC_MAJOR = 0;
const SUPPORTED_SPEC_MINOR = 1;

module.exports = function validate(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const jsonOut = argv.includes('--json');
  if (!jsonOut) {
    console.log(banner({ version: cliVersion(ctx), tagline: 'lint .cues/ configs' }));
    console.log('');
  }
  const projectOnly = argv.includes('--project');
  const userOnly = argv.includes('--user');
  const strict = argv.includes('--strict');

  let core;
  try {
    core = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/index.js'));
  } catch (err) {
    console.error(`opencues validate: failed to load @opencues/core (have you run \`pnpm build\`?)`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }
  const {
    parseCuesMd, parseSingleCueMd, parseSingleAuditorMd,
    inferHostCompat, unknownHostNames, validateEndpoint,
  } = core;

  const HOME = os.homedir();
  const searchPaths = [];
  if (!userOnly) searchPaths.push({ label: 'project', dir: path.join(process.cwd(), '.cues') });
  if (!projectOnly) searchPaths.push({ label: 'user', dir: path.join(HOME, '.cues') });

  // Findings collector. Each entry: { rule, severity: 'error'|'warn'|'info', file, summary }.
  const findings = [];
  const lint = (rule, severity, file, summary) => findings.push({ rule, severity, file, summary });

  // Per-kind name → source-file map for duplicate detection within a single file.
  const seen = { cue: new Map(), blank: new Map(), auditor: new Map() };

  // Track every word-cue source we see so we can warn on entries that
  // would be dropped at runtime (no match: / no keywords: → not routable).
  const wordCueSources = []; // [{file, name, hasMatch, hasKeywords, priority}]

  for (const { label, dir } of searchPaths) {
    if (!fs.existsSync(dir)) {
      if (!jsonOut) console.log(`${dim(label + '-level')} ${dir} ${dim('(missing — skipped)')}`);
      continue;
    }
    if (!jsonOut) console.log(`${bold('Checking')} ${bold(label + '-level')} ${dim(fileLink(dir, dir))}`);
    walkConfigDir(dir, label, {
      parseCuesMd, parseSingleCueMd, parseSingleAuditorMd,
      inferHostCompat, unknownHostNames, validateEndpoint,
    }, seen, lint, wordCueSources);
  }

  checkUnroutableWordCues(wordCueSources, lint);

  // Output.
  if (jsonOut) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    console.log('');
    for (const f of findings) renderFinding(f);
    console.log('');
    const errCount = findings.filter(f => f.severity === 'error').length;
    const warnCount = findings.filter(f => f.severity === 'warn').length;
    const summary = `${bold(errCount)} error(s), ${bold(warnCount)} warning(s)`;
    if (errCount === 0 && warnCount === 0) console.log(`${tag('ok')} ${summary}`);
    else if (errCount === 0)               console.log(`${tag('warn')} ${summary}`);
    else                                   console.log(`${tag('err')} ${summary}`);
  }

  const errCount = findings.filter(f => f.severity === 'error').length;
  const warnCount = findings.filter(f => f.severity === 'warn').length;
  if (errCount > 0) process.exit(1);
  if (strict && warnCount > 0) process.exit(1);
};

function renderFinding(f) {
  const t = f.severity === 'error' ? tag('err') : f.severity === 'warn' ? tag('warn') : tag('info');
  console.log(`  ${t} ${dim('[' + f.rule + ']')} ${f.file}: ${f.summary}`);
}

function walkConfigDir(dir, label, tools, seen, lint, wordCueSources) {
  const {
    parseCuesMd, parseSingleCueMd, parseSingleAuditorMd,
    inferHostCompat, unknownHostNames, validateEndpoint,
  } = tools;

  // Static-alts cues (LocalCueSource) classify per-word against their
  // JSON words map; they don't need match/keywords. Detect by JSON body.
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

  // Master files: CUES.md, BLANKS.md. Duplicates within one file = error.
  for (const [filename, kind] of [['CUES.md', 'cue'], ['BLANKS.md', 'blank']]) {
    const p = path.join(dir, filename);
    if (!fs.existsSync(p)) continue;
    try {
      const content = fs.readFileSync(p, 'utf8');
      const parsed = parseCuesMd(content);
      const looksLikeFrontmatterAttempt = /^---\s*$/m.test(content);
      const parsedNothing =
        (!parsed?.frontmatter || Object.keys(parsed.frontmatter).length === 0) &&
        (!parsed?.sections || Object.keys(parsed.sections).length === 0) &&
        (!parsed?.promptConfig?.sources || Object.keys(parsed.promptConfig.sources).length === 0);
      if (looksLikeFrontmatterAttempt && parsedNothing) {
        lint('master-malformed', 'error', p, `looks like frontmatter is malformed — nothing parsed`);
      }
      checkSpecVersion(p, content, lint);
      const namesInThisFile = new Set();
      if (parsed && parsed.promptConfig && parsed.promptConfig.sources) {
        for (const [name, src] of Object.entries(parsed.promptConfig.sources)) {
          if (namesInThisFile.has(name)) {
            lint('name-collision', 'error', p, `duplicate name "${name}" within file`);
          }
          namesInThisFile.add(name);
          seen[kind].set(name, p);
          checkHostCompat(p, name, src, inferHostCompat, unknownHostNames, lint);
          checkEndpoint(p, name, src, validateEndpoint, lint);
          if (kind === 'cue') noteWordCue(name, src, p);
        }
      }
      if (parsed && parsed.blanks) {
        for (const [name, blk] of Object.entries(parsed.blanks)) {
          seen.blank.set(name, p);
          checkHostCompat(p, name, blk, inferHostCompat, unknownHostNames, lint);
          checkEndpoint(p, name, blk, validateEndpoint, lint);
        }
      }
    } catch (err) {
      lint('parse-failed', 'error', p, `parse failed — ${err.message}`);
    }
  }

  // AUDITORS.md master. Readable check + spec version.
  const auditorsMaster = path.join(dir, 'AUDITORS.md');
  if (fs.existsSync(auditorsMaster)) {
    try {
      const content = fs.readFileSync(auditorsMaster, 'utf8');
      checkSpecVersion(auditorsMaster, content, lint);
    } catch (err) {
      lint('parse-failed', 'error', auditorsMaster, `read failed — ${err.message}`);
    }
  }

  // OPENCUES.md — readable check only (runtime-specific schema).
  for (const settingsName of ['OPENCUES.md', 'opencues.md']) {
    const settingsPath = path.join(dir, settingsName);
    if (!fs.existsSync(settingsPath)) continue;
    try { fs.readFileSync(settingsPath, 'utf8'); }
    catch (err) { lint('parse-failed', 'error', settingsPath, `read failed — ${err.message}`); }
    break;
  }

  // Per-folder sources: cues/<name>/CUE.md, blanks/<name>/BLANK.md, auditors/<name>/AUDITOR.md.
  for (const [subdir, kind, primaryFile] of [
    ['cues',     'cue',     'CUE.md'],
    ['blanks',   'blank',   'BLANK.md'],
    ['auditors', 'auditor', 'AUDITOR.md'],
  ]) {
    const sub = path.join(dir, subdir);
    if (!fs.existsSync(sub) || !fs.statSync(sub).isDirectory()) continue;
    for (const entry of fs.readdirSync(sub, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidates = [primaryFile, primaryFile.toLowerCase()];
      const sourceFile = candidates
        .map(f => path.join(sub, entry.name, f))
        .find(p => fs.existsSync(p));
      if (!sourceFile) {
        lint('source-empty-folder', 'warn', path.join(sub, entry.name), `has no ${primaryFile}`);
        continue;
      }
      try {
        const content = fs.readFileSync(sourceFile, 'utf8');
        const folderParsed = kind === 'auditor'
          ? parseSingleAuditorMd(content, path.dirname(sourceFile))
          : parseSingleCueMd(content, path.dirname(sourceFile));
        seen[kind].set(entry.name, sourceFile);

        checkSpecVersion(sourceFile, content, lint);
        checkNameField(sourceFile, kind, folderParsed.frontmatter, lint);

        if (kind === 'cue') {
          checkCueBody(sourceFile, folderParsed, lint);
          noteWordCue(entry.name, folderParsed.frontmatter, sourceFile, content);
          checkHostCompat(sourceFile, entry.name, folderParsed.frontmatter, inferHostCompat, unknownHostNames, lint);
          checkEndpoint(sourceFile, entry.name, folderParsed.frontmatter, validateEndpoint, lint);
        } else if (kind === 'blank') {
          checkBlankKeywords(sourceFile, folderParsed.frontmatter, lint);
          checkBlankBindings(sourceFile, folderParsed.frontmatter, content, lint);
          checkBlankScript(sourceFile, folderParsed.frontmatter, content, lint);
          checkBlankSandbox(sourceFile, folderParsed.frontmatter, lint);
          checkBlankImpl(sourceFile, folderParsed.frontmatter, content, lint);
          checkHostCompat(sourceFile, entry.name, folderParsed.frontmatter, inferHostCompat, unknownHostNames, lint);
          checkEndpoint(sourceFile, entry.name, folderParsed.frontmatter, validateEndpoint, lint);
        } else if (kind === 'auditor') {
          checkAuditorBody(sourceFile, folderParsed, lint);
          checkHostCompat(sourceFile, entry.name, folderParsed.frontmatter, inferHostCompat, unknownHostNames, lint);
        }
      } catch (err) {
        lint('parse-failed', 'error', sourceFile, `parse failed — ${err.message}`);
      }
    }
  }
}

// ─── Per-rule check helpers ─────────────────────────────────────────────────

// spec-too-new: file declares spec: opencues/<M>.<N> with version strictly
// newer than this runtime's SUPPORTED_SPEC_*. Absent spec: is treated as
// the current version (per core.md § Status & versioning).
function checkSpecVersion(file, content, lint) {
  const m = content.match(/^\s*spec\s*:\s*opencues\/([0-9]+)\.([0-9]+)/m);
  if (!m) return;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  const tooNew = major > SUPPORTED_SPEC_MAJOR ||
    (major === SUPPORTED_SPEC_MAJOR && minor > SUPPORTED_SPEC_MINOR);
  if (tooNew) {
    lint('spec-too-new', 'error', file,
      `declares spec: opencues/${major}.${minor}, newer than this runtime's opencues/${SUPPORTED_SPEC_MAJOR}.${SUPPORTED_SPEC_MINOR}-alpha`);
  }
}

// cue-missing-name / blank-missing-name / auditor-missing-name.
function checkNameField(file, kind, frontmatter, lint) {
  if (frontmatter && frontmatter.name) return;
  const rule = `${kind}-missing-name`;
  lint(rule, 'error', file, `${kind === 'auditor' ? 'AUDITOR.md' : kind.toUpperCase() + '.md'} frontmatter has no name field`);
}

// cue-empty-body + cue-missing-trigger (the latter is also surfaced via
// checkUnroutableWordCues at end-of-walk, but emit per-file too for
// fixture-precise reporting).
function checkCueBody(file, parsed, lint) {
  const fm = parsed.frontmatter || {};
  // Static cues don't need triggers — the JSON words map is the trigger.
  const isStatic = !!(parsed.tips && parsed.tips.length > 0);
  // Sentence-scope cues apply to whole sentences, not per-word; they
  // legitimately omit match: / keywords: (see core.md § Routing and the
  // shipped `more-formal` cue).
  const isSentenceScope = fm.scope === 'sentence';
  const src = parsed.promptConfig?.sources && Object.values(parsed.promptConfig.sources)[0];
  const hasPromptText = !!(src && src.promptText && src.promptText.trim().length > 0);
  if (!isStatic && !hasPromptText) {
    lint('cue-empty-body', 'error', file, `body has neither a JSON tip-group block nor non-empty prompt text — no behaviour declared`);
  }
  if (!isStatic && !isSentenceScope && !fm.match && !fm.keywords) {
    lint('cue-missing-trigger', 'error', file, `frontmatter declares neither match: nor keywords: — cue would be unreachable`);
  }
}

// blank-missing-keywords.
function checkBlankKeywords(file, frontmatter, lint) {
  if (frontmatter && frontmatter.blankKeywords) return;
  lint('blank-missing-keywords', 'error', file, `frontmatter has no blankKeywords field — blank would never fire`);
}

// blank-multiple-bindings + blank-no-binding. Reads raw content for
// multi-binding because the parser collapses to a single profile.
function checkBlankBindings(file, frontmatter, content, lint) {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return;
  const raw = fmMatch[1];
  const profiles = [
    /^\s*stepValues\s*:/m.test(raw),
    /^\s*blankScript\s*:/m.test(raw),
    /^\s*impl\s*:/m.test(raw),
  ].filter(Boolean).length;
  if (profiles > 1) {
    lint('blank-multiple-bindings', 'error', file, `declares more than one binding profile (stepValues / blankScript / impl) — exactly one is allowed`);
  }
  // blank-no-binding: zero bindings AND no implicit-impl-by-name path.
  // Implicit impl is the convention `<PascalCase(name)>Blank`; the parser
  // can't tell whether that class exists in the runtime registry, so we
  // surface zero-explicit-bindings as a warn rather than error here.
  if (profiles === 0) {
    lint('blank-no-binding', 'warn', file, `declares zero binding profiles (no stepValues / blankScript / impl) — implicit-impl-by-name may resolve at runtime, otherwise the blank is unreachable`);
  }
}

// blank-script-missing. (Tagged version of the existing script-exists check.)
function checkBlankScript(file, frontmatter, _content, lint) {
  const scriptPath = frontmatter && frontmatter.blankScript;
  if (!scriptPath) return;
  // The parser preserves relative paths if no `type: blank` was set; the
  // blank branch resolves them. Handle both shapes.
  let resolved = scriptPath;
  if (scriptPath.startsWith('./')) resolved = path.join(path.dirname(file), scriptPath.slice(2));
  if (!path.isAbsolute(resolved)) resolved = path.join(path.dirname(file), resolved);
  if (!fs.existsSync(resolved)) {
    lint('blank-script-missing', 'error', file, `blankScript: references ${scriptPath} which is not present in the blank's folder`);
    return;
  }
  try {
    const stat = fs.statSync(resolved);
    if (!(stat.mode & 0o111)) {
      lint('blank-script-not-executable', 'warn', file, `blankScript: ${scriptPath} is not executable (chmod +x recommended)`);
    }
  } catch { /* ignore */ }
}

function checkBlankSandbox(file, frontmatter, lint) {
  const fm = frontmatter || {};
  if (fm.blankScript && fm.sandbox === undefined) {
    lint('blank-sandbox-unset', 'warn', file,
      `blankScript declared without sandbox: setting. Add \`sandbox: strict\` (recommended) or \`sandbox: off\` with a rationale.`);
  }
}

function checkBlankImpl(file, frontmatter, content, lint) {
  const implMatch = content.match(/^\s*impl\s*:\s*(.+)$/m);
  if (!implMatch) return;
  const implRaw = implMatch[1].trim().replace(/^["']|["']$/g, '');
  if (!(implRaw.startsWith('./') || implRaw.startsWith('../'))) return;
  const jsPath = path.join(path.dirname(file), implRaw);
  if (!fs.existsSync(jsPath)) {
    lint('blank-impl-missing', 'error', file, `impl: points to ${jsPath} which does not exist`);
    return;
  }
  const fm = frontmatter || {};
  const hasCap = (fm.userBlankNetwork && fm.userBlankNetwork.length)
    || fm.userBlankLlm || fm.userBlankStorage;
  if (!hasCap) {
    lint('blank-impl-no-capabilities', 'warn', file,
      `user-shipped JS blank with no capabilities declared — add \`network: [...]\`, \`llm: <provider>\`, or \`storage: <namespace>\` to enable.`);
  }
  checkUserBlankCapabilities(file, fm, jsPath, lint);
}

// auditor-empty-body.
function checkAuditorBody(file, parsed, lint) {
  const auditor = parsed.auditors && Object.values(parsed.auditors)[0];
  const hasBody = !!(auditor && auditor.promptText && auditor.promptText.trim().length > 0);
  if (!hasBody) {
    lint('auditor-empty-body', 'error', file, `AUDITOR.md body is empty — no prompt concern declared, auditor would no-op`);
  }
}

// cue-missing-trigger (cross-file aggregate). Word-cue sources without
// match: AND keywords: are dropped silently at runtime.
function checkUnroutableWordCues(wordCueSources, lint) {
  if (wordCueSources.length === 0) return;
  const byName = new Map();
  for (const s of wordCueSources) {
    const cur = byName.get(s.name);
    if (!cur || s.priority > cur.priority) byName.set(s.name, s);
  }
  for (const s of byName.values()) {
    if (!s.hasMatch && !s.hasKeywords) {
      lint('cue-missing-trigger', 'error', s.file,
        `word-cue source "${s.name}" has neither match: nor keywords: — would be dropped at runtime (use \`match: .*\` for catch-all)`);
    }
  }
}

// JS-blank capability hygiene (orphan bindings, out-of-allow-list hosts,
// unused secrets). Same checks as the previous implementation; tagged
// with rule codes so JSON consumers can filter.
function checkUserBlankCapabilities(cueMd, fm, jsPath, lint) {
  const secrets = fm.userBlankSecrets || [];
  const bindings = fm.userBlankSecretBindings || {};
  const network = fm.userBlankNetwork || [];
  const netLower = new Set(network.map(h => h.toLowerCase()));
  const declaredNames = new Set(secrets);

  for (const name of Object.keys(bindings)) {
    if (!declaredNames.has(name)) {
      lint('blank-secret-binding-orphan', 'warn', cueMd,
        `secret-hosts.${name} declared but "${name}" is not in secrets: [...]. Add to secrets: or remove the binding.`);
    }
  }
  for (const [name, hosts] of Object.entries(bindings)) {
    if (!Array.isArray(hosts)) continue;
    for (const h of hosts) {
      if (!netLower.has(String(h).toLowerCase())) {
        lint('blank-secret-binding-unreachable', 'warn', cueMd,
          `secret-hosts.${name} lists "${h}" which is not in network: [...]. Add to network: or drop the binding.`);
      }
    }
  }
  if (secrets.length > 0 && fs.existsSync(jsPath)) {
    let src = '';
    try { src = fs.readFileSync(jsPath, 'utf8'); } catch { /* */ }
    for (const name of secrets) {
      const dot = new RegExp(`\\bctx\\.secrets\\.${name}\\b`).test(src);
      const bracket = new RegExp(`\\bctx\\.secrets\\[\\s*['"]${name}['"]\\s*\\]`).test(src);
      const destruct = new RegExp(`\\b${name}\\b`).test(src) && /ctx\.secrets/.test(src);
      if (!dot && !bracket && !destruct) {
        lint('blank-secret-unused', 'warn', cueMd,
          `secrets: [${name}] declared but ctx.secrets.${name} not referenced in ${path.basename(jsPath)}. Remove or use it.`);
      }
    }
  }
}

function checkEndpoint(file, name, src, validateEndpoint, lint) {
  if (!src || !validateEndpoint) return;
  const provider = src.provider;
  const endpoint = src.endpoint;
  if (!provider && !endpoint) return;
  const r = validateEndpoint(provider, endpoint);
  if (!r.ok) {
    lint('endpoint-invalid', 'error', file, `${name}: ${r.warning}`);
    return;
  }
  if (r.kind === 'custom') {
    lint('endpoint-custom', 'warn', file, `${name}: ${r.warning}`);
  }
}

function checkHostCompat(file, name, src, inferHostCompat, unknownHostNames, lint) {
  if (!src) return;
  const onHost = src.onHost ?? src['on-host'];
  const notOnHost = src.notOnHost ?? src['not-on-host'];
  for (const bad of unknownHostNames(onHost)) {
    lint('unknown-host', 'error', file, `${name}: unknown host in on-host: "${bad}"`);
  }
  for (const bad of unknownHostNames(notOnHost)) {
    lint('unknown-host', 'error', file, `${name}: unknown host in not-on-host: "${bad}"`);
  }
  const compat = inferHostCompat(src);
  if (compat.hosts.length === 0) {
    lint('host-compat-empty', 'warn', file, `${name}: host-compat resolves to 0 hosts — this entry will never run`);
  }
}

function printHelp() {
  console.log('opencues validate [--project] [--user] [--strict] [--json]');
  console.log('');
  console.log('Walk the .cues/ search paths, parse every .md, report issues');
  console.log('tagged with their spec lint-rule codes (see spec/core.md § Linting rules).');
  console.log('Exit 0 on success, 1 on errors (or warnings with --strict).');
  console.log('');
  console.log('  --project    Only check <cwd>/.cues/');
  console.log('  --user       Only check ~/.cues/');
  console.log('  --strict     Treat warnings as errors');
  console.log('  --json       Machine-readable findings to stdout (for CI / conformance runners)');
  console.log('  --help       Show this message');
  console.log('');
  console.log('Spec-rule coverage (errors unless noted):');
  console.log('  cue-missing-name, cue-missing-trigger, cue-empty-body');
  console.log('  blank-missing-name, blank-missing-keywords, blank-multiple-bindings');
  console.log('  blank-no-binding (warn), blank-script-missing');
  console.log('  auditor-missing-name, auditor-empty-body');
  console.log('  spec-too-new, unknown-host, name-collision');
  console.log('');
  console.log('Additional runtime hygiene (warn):');
  console.log('  blank-sandbox-unset, blank-impl-missing, blank-impl-no-capabilities,');
  console.log('  blank-secret-binding-orphan, blank-secret-binding-unreachable,');
  console.log('  blank-secret-unused, endpoint-invalid, endpoint-custom,');
  console.log('  host-compat-empty, source-empty-folder, parse-failed');
}
