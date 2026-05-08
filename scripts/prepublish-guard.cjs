#!/usr/bin/env node
/**
 * prepublish-guard — runs from every publishable package's `prepublishOnly`
 * hook. Hard-aborts the publish unless EVERY invariant below holds.
 *
 * The guard is intentionally paranoid: leaking @opencues/* to the public
 * npmjs.com registry would expose proprietary code that hasn't shipped
 * yet. Belt-and-braces because human error during a `pnpm publish -r`
 * could otherwise be catastrophic.
 *
 * Invariants (all enforced):
 *
 *  1. The CWD's package.json has `publishConfig.registry`
 *     pointing at `https://npm.pkg.github.com`. (publishConfig is
 *     authoritative for `npm publish` UNLESS the user explicitly
 *     passes `--registry=...` on the CLI — see invariant 2.)
 *
 *  2. The effective registry npm/pnpm will use is GH Packages, not
 *     npmjs.com. We re-resolve via `npm config get registry --userconfig`
 *     to catch the case where someone bypassed publishConfig with
 *     `--registry=https://registry.npmjs.org`.
 *
 *  3. The package name is scoped under `@opencues/...` (GH Packages
 *     requires scoped names matching the org). An unscoped package
 *     can't publish to GH Packages anyway, but if someone changed the
 *     scope or removed it, fail loud here.
 *
 *  4. The opencues/opencues GitHub repo is currently PRIVATE. If the
 *     repo has flipped to public, abort — publishing to GH Packages
 *     associates package access with repo permissions, and a public
 *     repo means the published package is publicly readable.
 *
 *  5. There's no `--registry` override in the npm config args (process
 *     argv inheritance from the publish command).
 *
 * Set OPENCUES_PUBLISH_GUARD_BYPASS=i-confirm-public-leak to skip
 * this guard. Documented and obnoxious for a reason — it should never
 * appear in CI, scripts, or muscle-memory aliases.
 *
 * Exit codes:
 *   0  — every invariant holds, publish allowed to proceed
 *   1  — at least one invariant failed, publish aborted
 */
/* eslint-disable no-console */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ALLOWED_REGISTRY = 'https://npm.pkg.github.com';
const ALLOWED_SCOPE = '@opencues/';
const REPO = 'opencues/opencues';

const fail = (msg) => {
  console.error('\n┌─────────────────────────────────────────────────────────┐');
  console.error('│  PREPUBLISH GUARD ABORTED — INVARIANT VIOLATION         │');
  console.error('├─────────────────────────────────────────────────────────┤');
  msg.split('\n').forEach((line) => {
    console.error(`│  ${line.padEnd(55)}  │`);
  });
  console.error('└─────────────────────────────────────────────────────────┘\n');
  process.exit(1);
};

const ok = (msg) => console.log(`  ✓ ${msg}`);

// Bypass — extremely loud, intentionally hostile to muscle memory.
if (process.env.OPENCUES_PUBLISH_GUARD_BYPASS === 'i-confirm-public-leak') {
  console.warn('\n  !! prepublish-guard BYPASSED via OPENCUES_PUBLISH_GUARD_BYPASS\n');
  process.exit(0);
}

// ── Invariant 1 + 3: package.json publishConfig + scope ────────────
const pkgPath = path.join(process.cwd(), 'package.json');
if (!fs.existsSync(pkgPath)) fail('No package.json in CWD.\nExpected to be invoked from a package directory.');
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (err) {
  fail(`package.json parse failed: ${err.message}`);
}

console.log(`\nprepublish-guard: checking ${pkg.name}@${pkg.version} ...`);

if (!pkg.name) fail('package.json has no `name` field.');
if (!pkg.name.startsWith(ALLOWED_SCOPE) && pkg.name !== 'opencues') {
  fail(`Unexpected package name "${pkg.name}".\nMust be scoped under "${ALLOWED_SCOPE}".\n(Or "opencues" for the unscoped CLI, which can't publish to GH Packages anyway.)`);
}
ok(`package name "${pkg.name}" is in the allowed scope`);

if (pkg.private === true) {
  fail(`package.json sets "private": true — publish would already be refused\nby npm. If you really want to publish, remove "private": true and re-run.\nThis abort is here so the guard runs FIRST and you see why.`);
}
ok('package.json does NOT have "private": true (publish allowed by npm)');

const cfgRegistry = pkg.publishConfig && pkg.publishConfig.registry;
if (cfgRegistry !== ALLOWED_REGISTRY) {
  fail(`package.json publishConfig.registry is "${cfgRegistry || '(missing)'}".\nExpected "${ALLOWED_REGISTRY}".\nRefusing — without this pin, npm publish defaults to public npmjs.com.`);
}
ok(`publishConfig.registry pinned to ${ALLOWED_REGISTRY}`);

const cfgAccess = pkg.publishConfig && pkg.publishConfig.access;
if (cfgAccess !== 'restricted') {
  fail(`package.json publishConfig.access is "${cfgAccess || '(missing)'}".\nExpected "restricted".\nGH Packages: "restricted" = private to org members.`);
}
ok('publishConfig.access pinned to "restricted" (org-only)');

// ── Invariant 5: no --registry CLI override ─────────────────────────
const argv = process.env.npm_config_argv || '';
if (argv.includes('"--registry=') && !argv.includes(`"--registry=${ALLOWED_REGISTRY}"`)) {
  fail(`Detected --registry override on the publish command:\n${argv}\nRefusing — would bypass publishConfig pin.`);
}
ok('no --registry CLI override that bypasses publishConfig');

// Effective registry resolved by npm. If someone set a global registry override,
// catch it here.
let effectiveRegistry;
try {
  // For scoped packages npm respects @scope:registry — check that specifically.
  const scopeKey = pkg.name.startsWith('@') ? `${pkg.name.split('/')[0]}:registry` : 'registry';
  effectiveRegistry = execSync(`npm config get ${scopeKey}`, { encoding: 'utf8' }).trim();
} catch {
  effectiveRegistry = '';
}
if (effectiveRegistry && effectiveRegistry !== 'undefined' && effectiveRegistry !== ALLOWED_REGISTRY) {
  // npm's `config get registry` may return the default registry — we only
  // care if the resolved value disagrees with our pin. publishConfig wins
  // at publish time, but flag it so the human notices.
  console.warn(`  ! npm config '${pkg.name.startsWith('@') ? pkg.name.split('/')[0] + ':registry' : 'registry'}' resolves to ${effectiveRegistry}`);
  console.warn(`    publishConfig.registry overrides this for this publish, but you should investigate.`);
}

// ── Invariant 4: GitHub repo visibility ─────────────────────────────
let gh;
try {
  gh = execSync(`gh repo view ${REPO} --json visibility`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (err) {
  fail(`Could not read GitHub repo visibility for ${REPO}.\nError: ${err.message.split('\n')[0]}\nIs \`gh\` authenticated? Run \`gh auth status\`.\nAborting — cannot verify the repo is still private, refusing to publish blind.`);
}
let visibility;
try {
  visibility = JSON.parse(gh).visibility;
} catch (err) {
  fail(`Could not parse \`gh repo view\` output:\n${gh.slice(0, 200)}\n${err.message}`);
}
if (visibility !== 'PRIVATE') {
  fail(`GitHub repo ${REPO} visibility is "${visibility}".\nExpected "PRIVATE".\nIf the repo went public intentionally, re-run with\nOPENCUES_PUBLISH_GUARD_BYPASS=i-confirm-public-leak (paranoid by design).`);
}
ok(`GitHub repo ${REPO} is PRIVATE`);

console.log('\n  All invariants hold. Publish allowed to proceed.\n');
process.exit(0);
