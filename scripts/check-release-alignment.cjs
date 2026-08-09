#!/usr/bin/env node
// check-release-alignment.cjs — is every surface telling the same story?
//
// WHY THIS EXISTS
//
// A release ships five surfaces: npm, the git tag, the GitHub release, the
// Homebrew tap and opencues.com. They are five separate repos, registries and
// deploys, and nothing but a human reading a checklist kept them in step. The
// v0.6.0 cut (Aug 2026) lost one to each gap:
//
//   - the tag went on BEFORE the release commit merged, so the tagged tree
//     still said `## [Unreleased]` — and that tree is what every user's
//     `~/.opencues/repo` clones, since the published CLI pins its checkout to
//     its own version tag
//   - the Homebrew formula was two releases behind, and its `assert_match`
//     had been stale even longer, so the formula test was passing against a
//     version the formula never shipped
//   - the site was announcing four unreleased features under a provisional
//     heading whose `# current date` renders as today
//   - the open-standard page sat at spec 0.10 through the 0.11 cut, and the
//     pass before it had moved only the version STRING, leaving the actual
//     0.10 surface (`on-site:` / `on-field:`) undocumented for two versions
//   - `llms.txt` was a 0-byte file at a live URL while the checklist called it
//     the curated index
//
// Every one of those is a comparison between two files. None needed judgement.
// So they belong in a script, not in a checklist someone reads at 2am.
//
// WHAT IT IS NOT
//
// It does not judge whether the site's PROSE is a good description of the
// release — that stays human. It only asserts that two places which must agree
// on a fact do agree on it.
//
// USAGE
//
//   node scripts/check-release-alignment.cjs            # local files + network
//   node scripts/check-release-alignment.cjs --offline  # skip npm / gh / brew
//   node scripts/check-release-alignment.cjs --deep     # also verify the brew sha256
//   OPENCUES_WEBSITE=/path/to/opencues-website node scripts/check-release-alignment.cjs
//
// Exit 0 = aligned. Exit 1 = at least one surface disagrees.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const SITE = process.env.OPENCUES_WEBSITE || path.join(os.homedir(), 'opencues-website');
const OFFLINE = process.argv.includes('--offline');
const DEEP = process.argv.includes('--deep');

const C = process.stdout.isTTY && !process.env.NO_COLOR;
const green = (s) => (C ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s) => (C ? `\x1b[31m${s}\x1b[0m` : s);
const dim = (s) => (C ? `\x1b[2m${s}\x1b[0m` : s);

let failures = 0;
let skipped = 0;
const ok = (what, detail) => console.log(`  ${green('●')} ${what}${detail ? dim(` — ${detail}`) : ''}`);
const bad = (what, detail, fix) => {
  failures += 1;
  console.log(`  ${red('●')} ${what}`);
  if (detail) console.log(`      ${detail}`);
  if (fix) console.log(`      ${dim(fix)}`);
};
const skip = (what, why) => { skipped += 1; console.log(`  ${dim('●')} ${dim(`${what} — skipped (${why})`)}`); };
const section = (t) => console.log(`\n${t}`);

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);
/** Run a command for its stdout; null on any failure (missing tool, network, non-zero). */
function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, ...opts }).trim();
  } catch { return null; }
}

// ── What the product repo believes ──────────────────────────────────────────

const cliVersion = JSON.parse(read(path.join(REPO, 'packages/opencues-cli/package.json'))).version;
const specVersion = (read(path.join(REPO, 'packages/opencues-core/src/spec-version.ts'))
  .match(/SPEC_VERSION\s*=\s*'([^']+)'/) || [])[1];

const changelog = read(path.join(REPO, 'CHANGELOG.md'));
// The newest RELEASED heading — `## [X.Y.Z] - YYYY-MM-DD`. `[Unreleased]` is
// deliberately not matched: a wave in progress is not a claim about a release.
const relMatch = changelog.match(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})/m);
const released = relMatch ? { version: relMatch[1], date: relMatch[2] } : null;

console.log(`\nrelease alignment ${dim(`— CLI ${cliVersion}, spec ${specVersion}, newest release ${released ? released.version : '(none)'}`)}`);

// ── 1. Inside the product repo ──────────────────────────────────────────────

section('Product repo');

if (!released) {
  bad('CHANGELOG has no released section', 'expected a `## [X.Y.Z] - YYYY-MM-DD` heading',
      'cut the release section before tagging (versioning.md § How to cut a release, step 2)');
} else if (released.version !== cliVersion) {
  bad('CLI version does not match the newest CHANGELOG release',
      `packages/opencues-cli = ${cliVersion}, CHANGELOG newest = ${released.version}`,
      'these must be identical: version = tag = npm = the tree users clone');
} else {
  ok('CLI version matches the newest CHANGELOG release', released.version);
}

const tag = `v${cliVersion}`;
const tagCommit = run('git', ['-C', REPO, 'rev-parse', '-q', '--verify', `${tag}^{commit}`]);
if (!tagCommit) {
  skip(`tag ${tag}`, 'not created yet');
} else {
  // ⚠ The v0.6.0 bug, mechanised: a tag pushed before the release commit
  // merged points at a tree whose CHANGELOG still says [Unreleased].
  const taggedChangelog = run('git', ['-C', REPO, 'show', `${tag}:CHANGELOG.md`]) || '';
  if (!taggedChangelog.includes(`## [${cliVersion}]`)) {
    bad(`tag ${tag} points at a tree with no release heading`,
        `${tag} → ${tagCommit.slice(0, 8)}, whose CHANGELOG has no \`## [${cliVersion}]\``,
        `the tag went on before the release PR merged. Fix: git checkout master && git pull && git tag -f ${tag} && git push -f origin ${tag}`);
  } else {
    ok(`tag ${tag} points at the release commit`, tagCommit.slice(0, 8));
  }
}

// ── 1b. The open standard ───────────────────────────────────────────────────
//
// SPEC_VERSION is stamped in eight places, and a bump that misses one leaves a
// spec doc claiming an older contract while the runtime enforces a newer one.
// The CLAUDE.md bump checklist lists them; this checks them.

section('Open standard');

if (!specVersion) {
  bad('could not read SPEC_VERSION', 'packages/opencues-core/src/spec-version.ts');
} else {
  const specStamps = [
    ['SPEC.md', 'SPEC.md', /\*\*Current version: `([^`]+)`/],
    ['spec/README.md', 'spec/README.md', /\*\*Status:\*\* `([^`]+)`/],
  ];
  // README + CHANGELOG carry their own shapes; SECURITY.md scopes the
  // standard's security claims and deliberately carries no version banner.
  for (const f of fs.readdirSync(path.join(REPO, 'spec')).filter((f) => f.endsWith('.md') && !['README.md', 'CHANGELOG.md', 'SECURITY.md'].includes(f))) {
    specStamps.push([`spec/${f}`, `spec/${f}`, /\*\*Status:\*\* `([^`]+)`/]);
  }
  const wrong = [];
  for (const [label, rel, re] of specStamps) {
    const abs = path.join(REPO, rel);
    if (!exists(abs)) continue;
    const found = (read(abs).match(re) || [])[1];
    // Banners carry `0.11-alpha`, SPEC.md carries `0.11` — compare the number.
    if (!found || found.split('-')[0] !== specVersion) wrong.push(`${label} says ${found || '(none)'}`);
  }
  if (wrong.length) {
    bad(`${wrong.length} spec file(s) stamp a version that is not SPEC_VERSION`,
        wrong.slice(0, 4).join('; ') + (wrong.length > 4 ? ` (+${wrong.length - 4} more)` : ''),
        `expected ${specVersion} — see CLAUDE.md § The bump checklist`);
  } else {
    ok(`every spec doc stamps SPEC_VERSION`, `${specStamps.length} files at ${specVersion}`);
  }

  const specLog = path.join(REPO, 'spec/CHANGELOG.md');
  const newestSpec = exists(specLog) ? (read(specLog).match(/^## \[(\d+\.\d+)(?:\.\d+)?-alpha\]/m) || [])[1] : null;
  if (!newestSpec) skip('spec/CHANGELOG.md', 'no released spec version found');
  else if (newestSpec !== specVersion) {
    bad('spec/CHANGELOG.md newest release is not SPEC_VERSION',
        `changelog = ${newestSpec}, spec-version.ts = ${specVersion}`,
        'release the [Unreleased] block under the new version header');
  } else ok('spec/CHANGELOG.md newest release matches SPEC_VERSION', newestSpec);
}

// ── 1c. Module versions ─────────────────────────────────────────────────────

section('Modules');

// Chrome carries its version TWICE: manifest.json is what chrome://extensions
// shows, package.json is what the monorepo tracks. They have drifted across
// five PRs before, leaving users unable to tell a reload apart from a no-op.
const chromeManifest = path.join(REPO, 'integrations/chrome/manifest.json');
const chromePkg = path.join(REPO, 'integrations/chrome/package.json');
if (exists(chromeManifest) && exists(chromePkg)) {
  const mv = JSON.parse(read(chromeManifest)).version;
  const pv = JSON.parse(read(chromePkg)).version;
  if (mv !== pv) {
    bad('chrome manifest.json and package.json disagree',
        `manifest = ${mv}, package = ${pv}`,
        'bump BOTH in the same commit — the manifest is the only version a user can see');
  } else ok('chrome manifest.json matches package.json', mv);
}

// The version map in CLAUDE.md is a snapshot people read to answer "what is
// shipped?". A stale row is a wrong answer with a confident format.
const claude = read(path.join(REPO, 'CLAUDE.md'));
const rows = [...claude.matchAll(/^\| `([^`]+\/)` \| `?([^`|]+?)`? \| (\d+\.\d+\.\d+) \|/gm)];
const drifted = [];
for (const [, dir, , stated] of rows) {
  const pkg = path.join(REPO, dir, 'package.json');
  if (!exists(pkg)) continue;
  const actual = JSON.parse(read(pkg)).version;
  if (actual !== stated) drifted.push(`${dir} table says ${stated}, package.json says ${actual}`);
}
if (!rows.length) skip('CLAUDE.md version map', 'table not found');
else if (drifted.length) {
  bad(`${drifted.length} row(s) of CLAUDE.md's version map are stale`,
      drifted.slice(0, 4).join('; ') + (drifted.length > 4 ? ` (+${drifted.length - 4} more)` : ''),
      'regenerate with the loop in CLAUDE.md § Package version map');
} else ok("CLAUDE.md's version map matches every package.json", `${rows.length} rows`);

// ── 2. The website ──────────────────────────────────────────────────────────

section(`Website ${dim(SITE)}`);

if (!exists(SITE)) {
  skip('every website check', `${SITE} not found — set OPENCUES_WEBSITE`);
} else {
  // 2a. The open-standard page is the one public description of the standard.
  // Checked for the VERSION STRINGS only; whether the prose describes the new
  // surface is a human call, and the checklist says so.
  const osPath = path.join(SITE, 'md/population/open-standard.md');
  if (!exists(osPath)) {
    skip('open-standard page', 'file not found');
  } else {
    const os_ = read(osPath);
    const stale = [...os_.matchAll(/(?:opencues\/|currently `|As of `)(\d+\.\d+)/g)]
      .map((m) => m[1]).filter((v) => v !== specVersion);
    if (stale.length) {
      bad('open-standard page cites a spec version that is not SPEC_VERSION',
          `page says ${[...new Set(stale)].join(', ')}, spec-version.ts says ${specVersion}`,
          'update the strings AND describe the new surface (check spec/CHANGELOG.md, not just the number)');
    } else if (!os_.includes(`\`${specVersion}\``)) {
      bad('open-standard page never mentions the current spec version', `expected \`${specVersion}\` somewhere in the page`);
    } else {
      ok('open-standard page cites the current spec version', specVersion);
    }
  }

  // 2b. The site's changelog must name the same newest release, with a real
  // date. `# current date` renders as TODAY at view time — fine for a
  // provisional entry, a lie on a shipped one.
  const siteLogPath = path.join(SITE, 'md/population/changelog.md');
  if (!exists(siteLogPath) || !released) {
    skip('site changelog', exists(siteLogPath) ? 'no released section to compare' : 'file not found');
  } else {
    const siteLog = read(siteLogPath);
    const entry = siteLog.match(/^# v(\d+\.\d+\.\d+)\s*\n# (.+)$/m);
    if (!entry) {
      bad('site changelog has no `# vX.Y.Z` entry', 'expected a version heading followed by a date line');
    } else if (entry[1] !== released.version) {
      bad('site changelog names a different newest release',
          `site says v${entry[1]}, product released ${released.version}`,
          'the paired website PR is part of the release (versioning.md step 8)');
    } else if (/current date/i.test(entry[2])) {
      bad(`site changelog still carries the placeholder date on v${entry[1]}`,
          '`# current date` renders as today at view time, so a shipped release appears to ship again every day',
          `replace it with the real date (e.g. # ${new Date(released.date).getUTCDate()}th ${new Date(released.date).toLocaleString('en', { month: 'short' }).toUpperCase()} ${new Date(released.date).getUTCFullYear()})`);
    } else {
      ok('site changelog names the same release, with a real date', `v${entry[1]} · ${entry[2]}`);
    }
  }

  // 2c. llms.txt is a published index. Empty is worse than absent: the URL
  // still serves 200 with nothing in it.
  const llmsPath = path.join(SITE, 'llms.txt');
  const sitemapPath = path.join(SITE, 'sitemap.xml');
  if (!exists(llmsPath) || !exists(sitemapPath)) {
    skip('llms.txt', 'file not found');
  } else {
    const llms = read(llmsPath);
    const indexed = new Set([...llms.matchAll(/\((https:\/\/opencues\.com[^)]*)\)/g)].map((m) => m[1].replace(/\/$/, '')));
    const published = new Set([...read(sitemapPath).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/\/$/, '')));
    const missing = [...published].filter((u) => !indexed.has(u));
    if (llms.trim().length === 0) {
      bad('llms.txt is empty', 'a 0-byte file served at a live URL', 'regenerate it from the sitemap');
    } else if (missing.length) {
      bad(`llms.txt is missing ${missing.length} published page(s)`,
          missing.slice(0, 3).join(', ') + (missing.length > 3 ? ` (+${missing.length - 3} more)` : ''),
          'regenerate it whenever the page set changes');
    } else {
      ok('llms.txt indexes every published page', `${indexed.size} entries`);
    }
  }
}

// ── 3. Published surfaces ───────────────────────────────────────────────────

section('Published');

if (OFFLINE) {
  skip('npm / GitHub release / Homebrew', '--offline');
} else {
  // 3a. npm
  const npmVersion = run('npm', ['view', 'opencues', 'version']);
  if (!npmVersion) {
    skip('npm', 'registry unreachable');
  } else if (npmVersion !== cliVersion) {
    bad('npm latest is not the CLI version',
        `npm = ${npmVersion}, packages/opencues-cli = ${cliVersion}`,
        'cd packages/opencues-cli && npm publish   (NOT `npm publish -w` — pnpm workspace)');
  } else {
    ok('npm latest matches the CLI version', npmVersion);
  }

  // 3b. GitHub release
  const relView = run('gh', ['release', 'view', tag, '--repo', 'opencues/opencues', '--json', 'tagName', '-q', '.tagName']);
  if (relView === null) {
    bad(`no GitHub release for ${tag}`, 'the repo front page still advertises the previous version',
        `gh release create ${tag} --title "OpenCues ${tag}" --notes-file <notes>`);
  } else {
    ok('GitHub release exists', relView);
  }

  // 3c. Homebrew. THREE things drift: url, sha256, and the version asserted by
  // the formula's own test — that last one was stale for two releases.
  const formula = run('gh', ['api', 'repos/opencues/homebrew-opencues/contents/Formula/opencues.rb', '-q', '.content']);
  if (!formula) {
    skip('Homebrew formula', 'tap unreachable');
  } else {
    const rb = Buffer.from(formula, 'base64').toString('utf8');
    const urlV = (rb.match(/opencues-(\d+\.\d+\.\d+)\.tgz/) || [])[1];
    const testV = (rb.match(/assert_match "(\d+\.\d+\.\d+)"/) || [])[1];
    if (urlV !== cliVersion) {
      bad('Homebrew formula url is a different version',
          `formula = ${urlV}, released = ${cliVersion}`,
          'brew users stay on the old release with no signal they are behind');
    } else if (testV !== cliVersion) {
      bad('Homebrew formula test asserts a different version',
          `assert_match "${testV}" while the formula ships ${cliVersion}`,
          'the formula test passes against a version it does not install');
    } else {
      ok('Homebrew formula url + test assert the released version', cliVersion);
    }
    if (DEEP && urlV === cliVersion) {
      const tarball = run('npm', ['view', `opencues@${cliVersion}`, 'dist.tarball']);
      const want = (rb.match(/sha256 "([a-f0-9]{64})"/) || [])[1];
      const got = tarball ? run('bash', ['-c', `curl -sL "${tarball}" | sha256sum | awk '{print $1}'`]) : null;
      if (!got) skip('Homebrew sha256', 'could not fetch the tarball');
      else if (got !== want) bad('Homebrew sha256 does not match the published tarball', `formula ${want.slice(0, 12)}…, registry ${got.slice(0, 12)}…`);
      else ok('Homebrew sha256 matches the published tarball', want.slice(0, 12) + '…');
    }
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────

console.log('');
if (failures) {
  console.log(`${red('●')} ${failures} surface(s) disagree${skipped ? dim(` · ${skipped} skipped`) : ''}.`);
  console.log(dim('  Each line above is two files that must agree and do not. See'));
  console.log(dim('  docs/architecture/versioning.md § How to cut a release.\n'));
  process.exit(1);
}
console.log(`${green('●')} every surface agrees${skipped ? dim(` · ${skipped} skipped`) : ''}.\n`);
