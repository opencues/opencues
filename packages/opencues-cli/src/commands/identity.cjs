// `opencues identity` — manage IDENTITY.md identity fields.
//
// IDENTITY.md (~/.cues/IDENTITY.md) is a YAML frontmatter file where each key
// becomes a identity field token consumed by FluidBlank (today) and
// TransformBlank (Phase-2, May 2026). Adding `firstName: Wilfred`
// derives a `[FIRST NAME]` token the LLM can emit; the runtime
// substitutes the real value before the buffer is written. Spec:
// docs/architecture/identity-context.md.
//
// Subcommands:
//   opencues identity                  → interactive interview
//   opencues identity list             → show current identity fields
//   opencues identity list --json      → JSON output (scriptable)
//   opencues identity set <key> <val>  → add or update one (also: add)
//   opencues identity remove <key>     → remove one (also: rm)
//   opencues identity path             → print absolute IDENTITY.md path
//   opencues identity --help           → this help

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const readline = require('node:readline');
const { tag, bold, dim, fileLink, banner, cliVersion } = require('../lib/style.cjs');

const IDENTITY_MD_PATH = path.join(os.homedir(), '.cues', 'IDENTITY.md');

// Lazy-load the validator from built core. Resolves a few candidate
// paths so the CLI works from a clone (REPO_ROOT/packages/...) as well
// as from a published install (sibling node_module). Mirrors the
// `_coreCache` pattern in import.cjs.
let _validatorCache = null;
function loadValidator() {
  if (_validatorCache) return _validatorCache;
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'opencues-core', 'dist', 'identity-validator.js'),
    path.resolve(__dirname, '..', '..', 'node_modules', '@opencues', 'core', 'dist', 'identity-validator.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      _validatorCache = require(c);
      return _validatorCache;
    }
  }
  throw new Error(`opencues identity: cannot locate validator (tried: ${candidates.join(', ')})`);
}

// Field catalogue for the interactive interview. Order matters — we
// walk top-to-bottom. Each entry pairs a YAML key with a prompt and an
// optional smart-default loader. Keys map 1:1 to IDENTITY.md frontmatter;
// add a new entry here to extend the interview without touching any
// other site.
const INTERVIEW_FIELDS = [
  { key: 'firstName',  prompt: 'First name',           defaultFrom: () => firstWord(gitConfig('user.name')) },
  { key: 'lastName',   prompt: 'Last name',            defaultFrom: () => restWords(gitConfig('user.name')) },
  { key: 'fullName',   prompt: 'Full name',            defaultFrom: () => gitConfig('user.name') },
  { key: 'pronouns',   prompt: 'Pronouns (he/him, she/her, they/them, …)' },
  { key: 'email',      prompt: 'Email',                defaultFrom: () => gitConfig('user.email') },
  { key: 'phone',      prompt: 'Phone' },
  { key: 'company',    prompt: 'Company' },
  { key: 'jobTitle',   prompt: 'Job title' },
  { key: 'github',     prompt: 'GitHub URL',           defaultFrom: () => githubUrl() },
  { key: 'linkedin',   prompt: 'LinkedIn URL' },
  { key: 'twitter',    prompt: 'Twitter / X handle' },
  { key: 'website',    prompt: 'Personal website' },
  { key: 'signOff',    prompt: 'Email sign-off' },
];

module.exports = function identity(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const sub = (argv[0] || '').toLowerCase();
  const rest = argv.slice(1);
  switch (sub) {
    case 'list':                                  return cmdList(rest);
    case 'add':
    case 'set':                                   return cmdSet(rest);
    case 'remove':
    case 'rm':                                    return cmdRemove(rest);
    case 'path':                                  return cmdPath();
    case '':                                      return cmdInterview(ctx);
    default:
      console.error(`opencues identity: unknown subcommand "${sub}"`);
      console.error('Run `opencues identity --help` for usage.');
      return 2;
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Subcommands
// ────────────────────────────────────────────────────────────────────────────

function cmdList(argv) {
  const wantsJson = argv.includes('--json');
  const fields = parseSentinelsMd(readUserMd());
  if (wantsJson) {
    console.log(JSON.stringify(
      fields.map(f => ({ key: f.key, token: deriveToken(f.key), value: f.value })),
      null, 2,
    ));
    return 0;
  }
  if (fields.length === 0) {
    console.log(`${tag('info')} no identity defined yet — run ${bold('opencues identity')} to add some`);
    console.log(dim(`file: ${IDENTITY_MD_PATH}`));
    return 0;
  }
  // Tidy two-column display: key, derived token, value.
  const rows = fields.map(f => [f.key, deriveToken(f.key), f.value]);
  const widths = [0, 0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  for (const [key, token, value] of rows) {
    console.log(`  ${bold(key.padEnd(widths[0]))}  ${dim(token.padEnd(widths[1]))}  ${value}`);
  }
  console.log('');
  console.log(dim(`${fields.length} identity field${fields.length === 1 ? '' : 's'} — ${IDENTITY_MD_PATH}`));
  return 0;
}

function cmdSet(argv) {
  const positional = argv.filter(a => !a.startsWith('-'));
  const [key, ...valueParts] = positional;
  const value = valueParts.join(' ');
  if (!key || !value) {
    console.error('opencues identity set: usage: opencues identity set <key> <value>');
    console.error('Example: opencues identity set jobTitle "Staff Engineer"');
    return 2;
  }
  const fields = parseSentinelsMd(readUserMd());
  const { validateSentinelWrite } = loadValidator();
  const r = validateSentinelWrite(fields, { op: 'set', key, value });
  if (!r.ok) {
    const errPrefix = r.error === 'collision' ? 'warn' : 'error';
    console.error(`${tag(errPrefix)} ${r.detail}`);
    if (r.error === 'collision') {
      console.error('The runtime keeps the first definition; this set would be silently dropped.');
      console.error(`Either rename ${bold(key)} to avoid collision, or run ${bold(`opencues identity remove ${r.context.conflictingKey}`)} first.`);
    } else if (r.error === 'capacity-exceeded') {
      console.error(dim(`USER.md path: ${IDENTITY_MD_PATH}`));
    }
    // Exit codes: shape errors (invalid-key, value-*, capacity) → 2,
    // state errors (collision) → 1. Matches the unix convention.
    return (r.error === 'collision') ? 1 : 2;
  }
  writeUserMd(r.fields);
  const token = deriveToken(key);
  const verb = r.action === 'added' ? 'added' : r.action === 'updated' ? 'updated' : 'unchanged';
  console.log(`${tag('ok')} ${verb} ${bold(key)} → ${dim(token)} = ${value}`);
  console.log(dim(`file: ${IDENTITY_MD_PATH}`));
  return 0;
}

function cmdRemove(argv) {
  const [key] = argv.filter(a => !a.startsWith('-'));
  if (!key) {
    console.error('opencues identity remove: usage: opencues identity remove <key>');
    return 2;
  }
  const fields = parseSentinelsMd(readUserMd());
  const { validateSentinelWrite } = loadValidator();
  const r = validateSentinelWrite(fields, { op: 'remove', key });
  if (!r.ok) {
    console.error(`${tag('error')} ${r.detail}`);
    if (r.error === 'not-found') {
      console.error(`Run ${bold('opencues identity list')} to see what's defined.`);
    }
    return 1;
  }
  writeUserMd(r.fields);
  console.log(`${tag('ok')} removed ${bold(key)} (${dim(deriveToken(key))})`);
  return 0;
}

function cmdPath() {
  // Pure scriptable: just print the absolute path, no banner, no
  // styling. `opencues identity path | xargs $EDITOR` etc.
  process.stdout.write(IDENTITY_MD_PATH + '\n');
  return 0;
}

async function cmdInterview(ctx) {
  if (!process.stdin.isTTY) {
    console.error('opencues identity: interview mode requires a TTY.');
    console.error('For non-interactive use: `opencues identity set <key> <value>`');
    return 2;
  }
  console.log(banner({ version: cliVersion(ctx), tagline: 'set up your identity fields' }));
  console.log('');
  console.log(dim('Each answer becomes a identity field token the LLM can emit; the runtime'));
  console.log(dim('substitutes your real value before it reaches the buffer. Press Enter to'));
  console.log(dim('accept the [default] in brackets, or Enter on its own to skip a field.'));
  console.log(dim(`File: ${IDENTITY_MD_PATH}`));
  console.log('');

  // Preload existing values so re-running the interview is a no-op for
  // fields the user already populated (Enter accepts the existing
  // value). Encourages re-running after `git config user.name` etc.
  // change.
  const existing = new Map(parseSentinelsMd(readUserMd()).map(f => [f.key, f.value]));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, a => resolve(a)));
  const result = [];

  try {
    for (const field of INTERVIEW_FIELDS) {
      const current = existing.get(field.key);
      const smart = current || (field.defaultFrom ? safe(field.defaultFrom) : '');
      const tokenHint = dim(`(→ ${deriveToken(field.key)})`);
      const promptLine = smart
        ? `${field.prompt} ${tokenHint} [${smart}]: `
        : `${field.prompt} ${tokenHint}: `;
      const answer = (await ask(promptLine)).trim();
      const value = answer || smart;
      if (value) result.push({ key: field.key, value });
    }
    console.log('');
    // Preserve any user-added keys we didn't ask about (e.g. an
    // earlier `opencues identity set favoriteEditor vim`). Append
    // them after the interview-collected ones.
    const interviewKeys = new Set(INTERVIEW_FIELDS.map(f => f.key));
    for (const [key, value] of existing) {
      if (!interviewKeys.has(key)) result.push({ key, value });
    }
    writeUserMd(result);
    console.log(`${tag('ok')} wrote ${result.length} identity field${result.length === 1 ? '' : 's'} → ${fileLink(IDENTITY_MD_PATH, IDENTITY_MD_PATH)}`);
    console.log('');
    console.log(dim('Activate identity field substitution in OPENCUES.md:'));
    console.log(`  ${bold('identity-context-mode: safe')}`);
    return 0;
  } finally {
    rl.close();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// IDENTITY.md parser + writer
// ────────────────────────────────────────────────────────────────────────────
//
// Local re-implementation rather than a cross-package import: the core
// parser lives in TS/ESM (`@opencues/core/identity fields.ts`) and the
// CLI ships as CJS. Re-importing through the built `dist/` shim is
// brittle (depends on the user having built core), and the parsing
// logic is small enough to duplicate. The contract is locked by tests
// in `identity fields.test.cjs` that compare derived tokens against the
// core's own test cases.

function readUserMd() {
  if (!fs.existsSync(IDENTITY_MD_PATH)) return '';
  return fs.readFileSync(IDENTITY_MD_PATH, 'utf8');
}

function parseSentinelsMd(content) {
  if (!content) return [];
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch || !fmMatch[1].trim()) return [];
  const fields = [];
  for (const line of fmMatch[1].split('\n')) {
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith(' ') || line.startsWith('\t')) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*?):\s*([^\n]*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let value = stripInlineComment(m[2]).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    fields.push({ key, value });
  }
  return fields;
}

function stripInlineComment(rest) {
  // Mirror core/identity fields.ts: split at first ` #` outside quotes.
  let inQuote = null;
  for (let i = 0; i < rest.length - 1; i++) {
    const ch = rest[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' && rest[i + 1] === '#') {
      return rest.slice(0, i);
    }
  }
  return rest;
}

function writeUserMd(fields) {
  fs.mkdirSync(path.dirname(IDENTITY_MD_PATH), { recursive: true });
  // Preserve the original body (anything after the closing `---`) so
  // the user's docstring + spec-reference notes survive. New file
  // ships with the same boilerplate as `opencues seed-configs`.
  const existing = readUserMd();
  const bodyMatch = existing.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  const body = bodyMatch ? bodyMatch[1] : `\n# IDENTITY.md — your personal data for OpenCues\n\nEdit any value above. Each key auto-derives a identity field token\n(\`firstName\` → \`[FIRST NAME]\`). Activate via \`identity-context-mode: safe\`\nin OPENCUES.md. Spec: \`docs/architecture/identity fields.md\`.\n`;
  // Render with aligned colons for human-friendliness (matches the
  // shipped IDENTITY.md template style).
  const longestKey = fields.reduce((m, f) => Math.max(m, f.key.length), 0);
  const lines = fields.map(f => {
    const v = needsQuoting(f.value) ? `"${f.value.replace(/"/g, '\\"')}"` : f.value;
    return `${f.key}:${' '.repeat(longestKey - f.key.length + 4)}${v}`;
  });
  const out = `---\n${lines.join('\n')}\n---\n${body.startsWith('\n') ? body : '\n' + body}`;
  fs.writeFileSync(IDENTITY_MD_PATH, out, 'utf8');
}

function needsQuoting(value) {
  // YAML special starters or trailing whitespace need quotes. Keep
  // the rule narrow: `@handle`, `#tag`, leading `-`, embedded `#`.
  // Most user values fit through unquoted.
  if (/^[#@&*!|>'"%-]/.test(value)) return true;
  if (/^(yes|no|true|false|null|on|off)$/i.test(value)) return true;
  if (/\s#/.test(value)) return true;          // would be parsed as inline comment
  if (/^\s|\s$/.test(value)) return true;       // leading/trailing whitespace
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Token derivation — keep in lockstep with core/identity fields.ts deriveToken
// ────────────────────────────────────────────────────────────────────────────

function deriveToken(key) {
  const spaced = key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  return `[${spaced}]`;
}

// ────────────────────────────────────────────────────────────────────────────
// Smart-default helpers
// ────────────────────────────────────────────────────────────────────────────

function gitConfig(key) {
  try {
    return execSync(`git config --global --get ${key}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return ''; }
}

function githubUrl() {
  // Try `gh api user` first (authenticated), fall back to scanning
  // `git config user.email` against github-noreply patterns.
  try {
    const login = execSync('gh api user --jq .login 2>/dev/null', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (login) return `https://github.com/${login}`;
  } catch { /* gh not installed or unauthenticated */ }
  const email = gitConfig('user.email');
  // GitHub's noreply emails encode the username: ID+username@users.noreply.github.com
  const m = email.match(/^\d+\+([^@]+)@users\.noreply\.github\.com$/);
  if (m) return `https://github.com/${m[1]}`;
  return '';
}

function firstWord(s) { return (s || '').trim().split(/\s+/)[0] || ''; }
function restWords(s) { return (s || '').trim().split(/\s+/).slice(1).join(' '); }
function safe(fn) { try { return fn() || ''; } catch { return ''; } }

// ────────────────────────────────────────────────────────────────────────────
// Help
// ────────────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log('opencues identity — manage IDENTITY.mdidentity (personal-data tokens).');
  console.log('');
  console.log('Usage:');
  console.log('  opencues identity                    interactive interview (writes IDENTITY.md)');
  console.log('  opencues identity list               show defined identity fields');
  console.log('  opencues identity list --json        JSON output (scriptable)');
  console.log('  opencues identity set <key> <value>  add or update one identity field');
  console.log('  opencues identity add <key> <value>  alias for set');
  console.log('  opencues identity remove <key>       remove a identity field');
  console.log('  opencues identity rm <key>           alias for remove');
  console.log('  opencues identity path               print absolute IDENTITY.md path');
  console.log('');
  console.log('Keys are arbitrary — anything matching `[A-Za-z][A-Za-z0-9_-]*` works.');
  console.log('The token is auto-derived: `firstName` → `[FIRST NAME]`, `signOff` → `[SIGN OFF]`.');
  console.log('');
  console.log('Activate identity field substitution in OPENCUES.md:');
  console.log('  identity-context-mode: safe   # tokens-only to LLM, real values substituted locally');
  console.log('  identity-context-mode: raw    # values inlined into the prompt (opt-in PII)');
  console.log('  identity-context-mode: off    # default — no identity field data leaves your machine');
  console.log('');
  console.log('Examples:');
  console.log('  opencues identity set jobTitle "Staff Engineer"');
  console.log('  opencues identity set signOff "Best from sunny London"');
  console.log('  opencues identity remove favoriteColor');
  console.log('  opencues identity list --json | jq \'.[] | .key\'');
  return 0;
}

// Exported for tests.
module.exports.__test__ = {
  parseSentinelsMd, deriveToken, needsQuoting, stripInlineComment, IDENTITY_MD_PATH,
};
