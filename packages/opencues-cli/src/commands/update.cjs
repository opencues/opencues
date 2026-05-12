// `opencues update [<host>] [--check] [--to <version>] [--no-pull] [--dry-run]`
//
// Three modes, depending on flags:
//
//   1. UPDATE (default)         — git pull + pnpm install + pnpm build + redeploy
//                                 either all installed integrations OR the named host.
//   2. CHECK   (--check)        — read each integration's compat.json + query upstream
//                                 for the host's latest version. Print whether an
//                                 upgrade is available, and how it relates to our
//                                 tested versions / compat range / known-incompatible
//                                 list. Read-only — never modifies anything.
//   3. UPGRADE (--to <version>) — rewrite the host pin to <version>, then run
//                                 the host installer to deploy at the new pin.
//                                 Refuses incompatible versions; warns + needs
//                                 --force for "in compat-range but untested".

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const compatLib = require('../lib/compat.cjs');
const { tag, step, bold, dim, banner, tree, G } = require('../lib/style.cjs');

const HOST_ALIASES = {
  'claude-code': 'claude-code', claudecode: 'claude-code', claude: 'claude-code', cc: 'claude-code',
  opencode: 'opencode', oc: 'opencode',
  chrome: 'chrome',
  'gemini-cli': 'gemini-cli', geminicli: 'gemini-cli', gemini: 'gemini-cli',
};
const ALL_HOSTS = ['claude-code', 'opencode', 'chrome', 'gemini-cli'];

module.exports = async function update(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  // Parse: first non-flag positional = host. Default = all detected.
  let host = null;
  let toVersion = null;
  let check = false, force = false, dryRun = false, skipPull = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--force') force = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--no-pull') skipPull = true;
    else if (a === '--to') toVersion = argv[++i];
    else if (!a.startsWith('-') && !host) host = a;
  }
  if (host) {
    if (!HOST_ALIASES[host]) {
      console.error(`opencues update: unknown host "${host}". Known: ${ALL_HOSTS.join(', ')}`);
      process.exit(2);
    }
    host = HOST_ALIASES[host];
  }

  // Mode dispatch.
  if (check) return doCheck(host, ctx);
  if (toVersion) return doUpgrade(host, toVersion, { force, dryRun }, ctx);
  return doUpdate(host, { skipPull, dryRun }, ctx);
};

// ─── MODE 1: UPDATE ─────────────────────────────────────────────────────

function doUpdate(host, { skipPull, dryRun }, ctx) {
  const HOME = os.homedir();
  const installed = detectInstalled(HOME, ctx.REPO_ROOT);
  const targets = host
    ? installed.filter(i => i.host === host)
    : installed;

  console.log(banner({
    version: ctx.pkg.version,
    tagline: host ? `update ${host} — rebuild + redeploy` : 'pull, build, redeploy',
  }));
  console.log('');

  if (host && targets.length === 0) {
    console.error(`${tag('err')} ${host} is not installed ${dim('(no install artefacts on disk)')}`);
    console.error(`     ${dim(`Run \`opencues install ${host}\` first, or run without a host to scan all.`)}`);
    process.exit(1);
  }

  const targetRows = targets.length
    ? targets.map(i => [bold(i.host), dim(`(${i.evidence})`)])
    : [[dim('(none — nothing to redeploy)'), '']];
  console.log(tree({ title: 'Targets', description: 'installed integrations to redeploy', rows: targetRows }));
  console.log('');

  const steps = [];
  // git pull + workspace deps + workspace build are global concerns —
  // run once even when targeting a single host.
  if (!skipPull) steps.push({ desc: 'git pull', argv: ['git', 'pull'], cwd: ctx.REPO_ROOT });
  steps.push({ desc: 'pnpm install', argv: ['pnpm', 'install'], cwd: ctx.REPO_ROOT });
  steps.push({ desc: 'pnpm build',   argv: ['pnpm', 'build'],   cwd: ctx.REPO_ROOT });
  for (const i of targets) {
    steps.push({
      desc: `redeploy ${i.host}`,
      argv: ['node', path.join(ctx.REPO_ROOT, 'integrations', i.folder, 'bin/install.cjs'), 'install'],
      cwd: ctx.REPO_ROOT,
    });
  }

  console.log(tree({
    title: 'Plan',
    description: 'commands that will run in order; stops at the first failure',
    rows: steps.map(s => [dim(s.argv.join(' ')), dim(`(cwd ${s.cwd})`)]),
  }));
  if (dryRun) { console.log(`\n${tag('info')} ${dim('[dry-run] Nothing executed.')}`); return; }
  console.log('');

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    console.log(step(i + 1, steps.length, bold(s.desc)));
    const r = spawnSync(s.argv[0], s.argv.slice(1), { cwd: s.cwd, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`\n${tag('err')} stopped: ${bold(s.desc)} exited ${r.status}`);
      process.exit(r.status ?? 1);
    }
    console.log('');
  }
  console.log(`${tag('ok')} update complete`);
}

// ─── MODE 2: CHECK ──────────────────────────────────────────────────────

async function doCheck(host, ctx) {
  const HOME = os.homedir();
  const targetHosts = host ? [host] : ALL_HOSTS;
  console.log(banner({ version: ctx.pkg.version, tagline: 'host version compatibility report' }));
  console.log('');

  for (const h of targetHosts) {
    const compat = compatLib.loadCompat(ctx.REPO_ROOT, h);
    if (!compat) {
      console.log(bold(`## ${h}`));
      console.log(`  ${tag('info')} ${dim('(no compat.json — host upgrade-checking not configured)')}\n`);
      continue;
    }
    console.log(bold(`## ${h}`) + dim(`  (host: ${compat['host-package'] || compat['host-repo'] || compat['host-runtime']})`));
    console.log(`  compat-range:    ${compat['compat-range']}`);
    console.log(`  tested:          ${formatTested(compat.tested)}`);
    if (compat['known-incompatible'] && compat['known-incompatible'].length) {
      const ki = compat['known-incompatible']
        .map(e => `${e.version || e['first-broken']} (${e.reason})`)
        .join(', ');
      console.log(`  incompatible:    ${ki}`);
    }

    if (compat['host-kind'] === 'npm') {
      const installedPin = compatLib.readNpmPin(HOME, compat) || '(not installed)';
      console.log(`  current pin:     ${compat['current-pin']}  (default; user fork: ${installedPin})`);
      const versions = await compatLib.queryNpmVersions(compat['host-package']);
      if (!versions) { console.log('  upstream check:  failed (no network or registry unavailable)\n'); continue; }
      const latest = versions[versions.length - 1];
      const latestInRange = [...versions].reverse().find(v => compatLib.matchesRange(v, compat['compat-range']));
      printNpmRecommendation(installedPin, latest, latestInRange, compat);
    } else if (compat['host-kind'] === 'git') {
      const pin = compatLib.readGitPin(ctx.REPO_ROOT, compat);
      if (!pin) { console.log('  current pin:     (could not read pin source)\n'); continue; }
      console.log(`  current pin:     ${pin.version} (sha ${pin.sha})`);
      const tags = await compatLib.queryGitHubTags(compat['host-repo']);
      if (!tags) { console.log('  upstream check:  failed (GitHub API unreachable or rate-limited)\n'); continue; }
      const latest = tags[0];
      const latestInRange = tags.find(t => compatLib.matchesRange(stripV(t.name), compat['compat-range']));
      printGitRecommendation(pin, latest, latestInRange, compat);
    } else {
      console.log(`  (host-kind=${compat['host-kind']} — no auto-upgrade. ` +
                  `${compat['min-version'] ? `Min version ${compat['min-version']}.` : ''})`);
    }
    console.log('');
  }
}

function printNpmRecommendation(installedPin, latest, latestInRange, compat) {
  console.log(`  upstream latest: ${latest}`);
  if (latestInRange && latestInRange !== latest) {
    console.log(`  latest in range: ${latestInRange}`);
  }
  if (installedPin === latest) {
    console.log(`  ${tag('ok')} on latest`);
    return;
  }
  // The "latest in range" version may STILL be in known-incompatible
  // (e.g. range = "2.1.x", incompatible = "2.1.119+"). Classify before
  // recommending an upgrade.
  if (latestInRange && installedPin !== latestInRange) {
    const cls = compatLib.classifyVersion(latestInRange, compat);
    if (cls.status === 'tested') {
      console.log(`  ${tag('ok')} upgrade available: ${installedPin} ${dim(G.arrow)} ${bold(latestInRange)} ${dim('(tested)')}`);
      console.log(`     Run: opencues update claude-code --to ${latestInRange}`);
    } else if (cls.status === 'compat-untested') {
      console.log(`  ${tag('warn')} upgrade candidate: ${installedPin} ${dim(G.arrow)} ${bold(latestInRange)} ${dim('(in compat-range, NOT tested by maintainer)')}`);
      console.log(`     Run: opencues update claude-code --to ${latestInRange}`);
    } else if (cls.status === 'incompatible') {
      console.log(`  ${tag('err')} latest in range (${latestInRange}) is INCOMPATIBLE: ${cls.reason}`);
      console.log(`     Stay on current pin until compat-range is narrowed or known-incompatible is updated.`);
    }
  }
  if (latest !== latestInRange) {
    const cls = compatLib.classifyVersion(latest, compat);
    if (cls.status === 'incompatible') {
      console.log(`  ${tag('err')} ${latest} is INCOMPATIBLE: ${cls.reason}`);
    } else if (cls.status === 'out-of-range') {
      console.log(`  ${tag('err')} ${latest} is OUTSIDE compat-range (${compat['compat-range']}) — needs OpenCues patch updates`);
    }
  }
}

function printGitRecommendation(currentPin, latestTag, latestInRangeTag, compat) {
  console.log(`  upstream latest: ${latestTag.name} (sha ${latestTag.sha})`);
  if (latestInRangeTag && latestInRangeTag.name !== latestTag.name) {
    console.log(`  latest in range: ${latestInRangeTag.name} (sha ${latestInRangeTag.sha})`);
  }
  const installedVer = `v${currentPin.version}`;
  const installedNorm = stripV(installedVer);
  const latestNorm = stripV(latestTag.name);
  if (installedNorm === latestNorm) {
    console.log(`  ${tag('ok')} on latest`);
    return;
  }
  if (latestInRangeTag && stripV(latestInRangeTag.name) !== installedNorm) {
    const cls = compatLib.classifyVersion(stripV(latestInRangeTag.name), compat);
    if (cls.status === 'tested') {
      console.log(`  ${tag('ok')} upgrade available: ${currentPin.version} ${dim(G.arrow)} ${bold(stripV(latestInRangeTag.name))} ${dim('(tested)')}`);
    } else if (cls.status === 'compat-untested') {
      console.log(`  ${tag('warn')} upgrade candidate: ${currentPin.version} ${dim(G.arrow)} ${bold(stripV(latestInRangeTag.name))} ${dim('(in compat-range, NOT tested by maintainer)')}`);
    }
    console.log(`     Run: opencues update opencode --to ${stripV(latestInRangeTag.name)}`);
  }
  if (latestNorm !== (latestInRangeTag && stripV(latestInRangeTag.name))) {
    const cls = compatLib.classifyVersion(latestNorm, compat);
    if (cls.status === 'out-of-range') {
      console.log(`  ${tag('err')} ${latestTag.name} is OUTSIDE compat-range — needs OpenCues patch updates`);
    } else if (cls.status === 'incompatible') {
      console.log(`  ${tag('err')} ${latestTag.name} is INCOMPATIBLE: ${cls.reason}`);
    }
  }
}

function formatTested(tested) {
  if (!Array.isArray(tested)) return '(none listed)';
  return tested.map(t => typeof t === 'string' ? t : `${t.version}@${t.sha}`).join(', ');
}

function stripV(s) { return String(s || '').replace(/^v/, ''); }

// ─── MODE 3: UPGRADE (--to) ────────────────────────────────────────────

async function doUpgrade(host, toVersion, { force, dryRun }, ctx) {
  if (!host) {
    console.error('opencues update --to <version>: must specify a host (e.g. opencues update claude-code --to 2.1.115)');
    process.exit(2);
  }
  const compat = compatLib.loadCompat(ctx.REPO_ROOT, host);
  if (!compat) {
    console.error(`opencues update: no compat.json for ${host} — can't upgrade automatically`);
    process.exit(1);
  }

  // Compatibility gate (same for both kinds — uses version string).
  const cls = compatLib.classifyVersion(toVersion, compat);
  if (cls.status === 'incompatible') {
    console.error(`opencues update: ${toVersion} is INCOMPATIBLE.`);
    console.error(`  Reason: ${cls.reason}`);
    console.error(`  Refusing to pin to a known-broken version.`);
    process.exit(1);
  }
  if (cls.status === 'out-of-range' && !force) {
    console.error(`opencues update: ${toVersion} is OUTSIDE compat-range (${compat['compat-range']}).`);
    console.error(`  OpenCues patches may not apply cleanly. Re-run with --force to override (you accept the risk).`);
    process.exit(1);
  }
  if (cls.status === 'compat-untested') {
    console.warn(`opencues update: ${toVersion} is in compat-range but NOT in the tested list. Should work but no maintainer guarantee.`);
  }

  // Per-host-kind dispatch.
  if (compat['host-kind'] === 'npm') {
    return doUpgradeNpm(host, toVersion, compat, { dryRun }, ctx);
  }
  if (compat['host-kind'] === 'git') {
    return doUpgradeGit(host, toVersion, compat, { dryRun }, ctx);
  }
  console.error(`opencues update: --to not supported for host-kind=${compat['host-kind']} (${host}).`);
  if (compat['host-kind'] === 'browser') {
    console.error(`Chrome auto-updates itself; no opencues-side pin to rewrite.`);
  }
  process.exit(1);
}

function doUpgradeNpm(host, toVersion, compat, { dryRun }, ctx) {
  const HOME = os.homedir();
  const loc = compat['pin-location'];
  const forkDir = (loc['fork-default'] || '').replace(/^~/, HOME);
  const pkgPath = path.join(forkDir, loc['path-from-fork'] || 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.error(`opencues update: pin location not found at ${pkgPath}.`);
    console.error(`Install ${host} first: opencues install ${host}`);
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const fieldPath = loc.field.split('.');
  let parent = pkg;
  for (let i = 0; i < fieldPath.length - 1; i++) parent = parent[fieldPath[i]] = parent[fieldPath[i]] || {};
  const oldValue = parent[fieldPath[fieldPath.length - 1]];

  console.log(`Plan:`);
  console.log(`  rewrite ${pkgPath}: ${loc.field} = "${toVersion}"  (was "${oldValue}")`);
  console.log(`  re-run: opencues install ${host}`);
  if (dryRun) { console.log('\n[dry-run] Nothing executed.'); return; }

  parent[fieldPath[fieldPath.length - 1]] = toVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`\nPin updated. Re-installing ${host} at ${toVersion}...\n`);
  runHostInstaller(host, ctx, { rollback: () => fixupRollbackHint(pkgPath, loc.field, oldValue, host) });
  console.log(`\n${tag('ok')} ${host} now pinned at ${bold(toVersion)} and installed.`);
  console.log(dim(`Consider adding ${toVersion} to integrations/${host}/compat.json's "tested" list once you've verified.`));
}

async function doUpgradeGit(host, toVersion, compat, { dryRun }, ctx) {
  // For git hosts we need both a version AND a SHA. Look up the tag's
  // SHA on GitHub. Accept either bare version ("1.4.12") or tag-prefixed
  // ("v1.4.12") from the user.
  const tags = await compatLib.queryGitHubTags(compat['host-repo']);
  if (!tags) {
    console.error(`opencues update: GitHub tags query for ${compat['host-repo']} failed (network or rate limit).`);
    console.error(`Edit ${path.join(ctx.REPO_ROOT, compat['current-pin-source']['path-from-repo'])} manually + re-run: opencues update ${host}`);
    process.exit(1);
  }
  const wantNorm = stripV(toVersion);
  const wantedTag = tags.find(t => stripV(t.name) === wantNorm);
  if (!wantedTag) {
    console.error(`opencues update: ${toVersion} not found in ${compat['host-repo']}'s recent tags.`);
    console.error(`Available recent tags: ${tags.slice(0, 8).map(t => t.name).join(', ')}...`);
    process.exit(1);
  }

  const oldPin = compatLib.readGitPin(ctx.REPO_ROOT, compat);
  const oldDisplay = oldPin ? `${oldPin.version}@${oldPin.sha}` : '(unknown)';
  const pinPath = path.join(ctx.REPO_ROOT, compat['current-pin-source']['path-from-repo']);

  console.log(`Plan:`);
  console.log(`  rewrite ${pinPath}: { version: "${wantNorm}", sha: "${wantedTag.sha}" }  (was ${oldDisplay})`);
  console.log(`  re-run: opencues install ${host}  (will git-checkout the new SHA in <fork>)`);
  if (dryRun) { console.log(`\n${tag('info')} ${dim('[dry-run] Nothing executed.')}`); return; }

  compatLib.writeGitPin(ctx.REPO_ROOT, compat, { version: wantNorm, sha: wantedTag.sha });
  console.log(`\nPin updated. Re-installing ${host} at ${wantNorm}@${wantedTag.sha}...\n`);
  runHostInstaller(host, ctx, {
    rollback: () => {
      console.error(`To roll back: edit ${pinPath} and re-run \`opencues install ${host}\``);
      if (oldPin) console.error(`  Previous pin: { version: "${oldPin.version}", sha: "${oldPin.sha}" }`);
    },
  });
  console.log(`\n${tag('ok')} ${host} now pinned at ${bold(`${wantNorm}@${wantedTag.sha}`)} and installed.`);
  console.log(dim(`Consider adding {version:"${wantNorm}",sha:"${wantedTag.sha}"} to integrations/${host}/compat.json's "tested" list once you've verified.`));
}

function runHostInstaller(host, ctx, { rollback }) {
  const installer = path.join(ctx.REPO_ROOT, 'integrations', host, 'bin/install.cjs');
  const r = spawnSync('node', [installer, 'install'], { cwd: ctx.REPO_ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\nInstall failed at new pin.`);
    if (rollback) rollback();
    process.exit(r.status ?? 1);
  }
}

function fixupRollbackHint(pkgPath, field, oldValue, host) {
  console.error(`Roll back by editing ${pkgPath} and setting ${field} = "${oldValue}", then re-run \`opencues install ${host}\``);
}

// ─── shared helpers ────────────────────────────────────────────────────

function detectInstalled(HOME, REPO_ROOT) {
  const out = [];
  const ccFork = path.join(HOME, 'claude-code-cues');
  if (fs.existsSync(path.join(ccFork, 'node_modules/@opencues/runtime'))) {
    out.push({ host: 'claude-code', folder: 'claude-code', evidence: `${ccFork}/node_modules/@opencues/runtime exists` });
  } else if (fs.existsSync(path.join(HOME, '.claude/opencues/runtime'))) {
    out.push({ host: 'claude-code', folder: 'claude-code', evidence: '~/.claude/opencues/runtime exists (legacy)' });
  }
  const ocFork = path.join(HOME, 'opencode-cues');
  if (fs.existsSync(path.join(ocFork, 'node_modules/@opencues/runtime'))) {
    out.push({ host: 'opencode', folder: 'opencode', evidence: `${ocFork}/node_modules/@opencues/runtime exists` });
  }
  if (fs.existsSync(path.join(REPO_ROOT, 'integrations/chrome/dist/content.js'))) {
    out.push({ host: 'chrome', folder: 'chrome', evidence: 'integrations/chrome/dist/content.js exists' });
  }
  const geminiFork = path.join(HOME, 'gemini-cli-cues');
  if (fs.existsSync(path.join(geminiFork, 'node_modules/@opencues/runtime'))) {
    out.push({ host: 'gemini-cli', folder: 'gemini-cli', evidence: `${geminiFork}/node_modules/@opencues/runtime exists` });
  }
  return out;
}

function printHelp() {
  console.log('opencues update [<host>] [--check | --to <version>] [--no-pull] [--dry-run] [--force]');
  console.log('');
  console.log('Three modes:');
  console.log('');
  console.log('  Default — pull latest opencues, install deps, rebuild, redeploy installed integrations.');
  console.log('            With <host>: only redeploy that one (still pulls + builds the workspace).');
  console.log('');
  console.log('  --check — read each integration\'s compat.json + query upstream (npm registry / GitHub');
  console.log('            tags) for the host\'s latest version. Print whether an upgrade is available');
  console.log('            and how it relates to our tested / compat-range / known-incompatible lists.');
  console.log('            Read-only. Without <host>: checks all four. With <host>: just that one.');
  console.log('');
  console.log('  --to <version> — rewrite the host pin (e.g. ~/claude-code-cues/package.json) to');
  console.log('            <version>, then run the host installer. Refuses known-incompatible versions;');
  console.log('            warns + needs --force for "in compat-range but untested". npm-kind hosts');
  console.log('            (CC) only — for git-pinned hosts (OC), edit the SHA in setup.sh manually.');
  console.log('');
  console.log('Examples:');
  console.log('  opencues update                          # update all installed');
  console.log('  opencues update claude-code              # update only CC');
  console.log('  opencues update --check                  # which hosts have upgrades available?');
  console.log('  opencues update claude-code --check      # is there a newer CC compatible with us?');
  console.log('  opencues update claude-code --to 2.1.115 # bump CC pin + reinstall');
  console.log('');
  console.log('Stops at the first failure. After this finishes, restart your editor integrations.');
}
