// `opencues cleanup` — find + kill orphan host processes.
//
// Long-running `opencues run <host>` invocations sometimes leak —
// terminal closes, the wrapper script dies, but the underlying `bun`
// (or `node`, or shell daemon) double-forks and outlives its parent.
// Over a few days a developer can accumulate dozens of stale processes
// all polling OPENCUES.md and fighting each other in the shared log.
//
// This command reports + reaps them. It's also called automatically
// from `opencues run <host>` BEFORE the new process spawns (the
// "predecessor-kill" rule: a fresh `opencues run` supersedes prior
// instances of the same host).
//
// Usage:
//   opencues cleanup                       list orphan processes
//   opencues cleanup --kill                SIGTERM them
//   opencues cleanup --kill --force        SIGKILL them
//   opencues cleanup --host opencode       restrict to one host
//   opencues cleanup --project <path>      restrict to one project
//   opencues cleanup --json                JSON output (scriptable)
//   opencues cleanup --self                include this process's ppid chain (debugging)
//   opencues cleanup --quiet               no output on `--kill` unless something dies
//
// The matchers are per-host. Add a new host's pattern to HOST_MATCHERS
// when you add a new integration whose launch shape is novel.

const { spawnSync } = require('node:child_process');
const { bold, dim, red, green, yellow, G } = require('../lib/style.cjs');

// Per-host process matchers. Each entry maps a host name to one or
// more substring patterns that uniquely identify a running instance.
// The matcher is a literal substring against the full `ps` command
// line — keep these specific enough to never catch unrelated processes
// but loose enough to survive small flag changes upstream.
const HOST_MATCHERS = {
  opencode: [
    // bun running OC's packages/opencode entry — both `--silent dev`
    // and the direct cwd-pinned form.
    'bun run --cwd packages/opencode',
    'bun run --silent dev --project',
  ],
  'gemini-cli': [
    // RegExp, not a string: the matcher does a literal `includes()` on
    // string patterns, so `.*` here would never match a real process
    // line — it has to be a real regex to span the fork path.
    /node .*gemini-cli/,
  ],
  shell: [
    'bun .*integrations/shell/src/daemon.ts',
    'bun .*integrations/shell/src/app.tsx',
    '/.opencues/vendor/tmux/bin/tmux -L opencues-',
  ],
  'claude-code': [
    // Patched fork — new ~/.opencues/forks/claude-code layout + legacy
    // ~/claude-code-cues* layout (both carry .../claude-code/cli.js).
    'forks/claude-code.*/cli\\.js',
    'claude-code-cues/cli.js',   // FORK-PATH-ALLOW: match a still-running legacy fork during transition
  ],
};

function knownHosts() {
  return Object.keys(HOST_MATCHERS);
}

function listProcs() {
  // `ps -eo pid,ppid,etime,args --no-headers` is portable across
  // GNU coreutils. We grab everything once; matching happens locally.
  const r = spawnSync('ps', ['-eo', 'pid,ppid,etime,args', '--no-headers']);
  if (r.status !== 0) return [];
  return r.stdout.toString().split('\n').filter(Boolean).map(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) return null;
    return { pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), elapsed: m[3], args: m[4] };
  }).filter(Boolean);
}

function findOrphans({ host, project, includeSelf = false }) {
  const procs = listProcs();
  const selfPid = process.pid;
  const ppidChain = new Set();
  if (!includeSelf) {
    let cur = selfPid;
    while (cur > 1) {
      ppidChain.add(cur);
      const me = procs.find(p => p.pid === cur);
      if (!me) break;
      cur = me.ppid;
    }
  }

  const hostsToScan = host ? [host] : knownHosts();
  const out = [];
  for (const h of hostsToScan) {
    const patterns = HOST_MATCHERS[h];
    if (!patterns) continue;
    for (const p of procs) {
      if (ppidChain.has(p.pid)) continue;
      let matched = false;
      for (const pat of patterns) {
        if (typeof pat === 'string' && p.args.includes(pat)) { matched = true; break; }
        if (pat instanceof RegExp && pat.test(p.args)) { matched = true; break; }
      }
      if (!matched) continue;
      if (project && !p.args.includes(project)) continue;
      out.push({ host: h, pid: p.pid, ppid: p.ppid, elapsed: p.elapsed, args: p.args });
    }
  }
  return out;
}

function killOne(pid, force) {
  try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); return true; }
  catch (e) { return false; }
}

function abbrevArgs(args, max = 80) {
  if (args.length <= max) return args;
  return args.slice(0, max - 1) + '…';
}

function usage() {
  console.log('opencues cleanup — find and kill orphan host processes from prior `opencues run` invocations.');
  console.log('');
  console.log('USAGE');
  console.log('  opencues cleanup                       list orphans (no kill)');
  console.log('  opencues cleanup --kill                SIGTERM them');
  console.log('  opencues cleanup --kill --force        SIGKILL them');
  console.log('  opencues cleanup --host <name>         restrict to one host: ' + knownHosts().join(', '));
  console.log('  opencues cleanup --project <path>      restrict to processes whose args include this path');
  console.log('  opencues cleanup --json                JSON output (scriptable)');
  console.log('  opencues cleanup --quiet               suppress output unless something dies');
  console.log('  opencues cleanup --self                include this process\'s ppid chain (debugging)');
  console.log('');
  console.log('Called automatically by `opencues run <host>` before each spawn — passing --no-cleanup');
  console.log('on `opencues run` disables the auto-call.');
}

function parseArgs(argv) {
  const out = { host: null, project: null, kill: false, force: false, json: false, quiet: false, self: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--kill' || a === '-k') out.kill = true;
    else if (a === '--force' || a === '-f') out.force = true;
    else if (a === '--json') out.json = true;
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--self') out.self = true;
    else if (a === '--host')    out.host = argv[++i];
    else if (a === '--project') out.project = argv[++i];
    else if (a.startsWith('--host='))    out.host = a.slice('--host='.length);
    else if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
  }
  return out;
}

module.exports = function cleanup(argv, _ctx) {
  const args = parseArgs(argv || []);
  if (args.help) { usage(); return 0; }

  if (args.host && !HOST_MATCHERS[args.host]) {
    console.error(`opencues cleanup: unknown host '${args.host}'. Known: ${knownHosts().join(', ')}`);
    return 2;
  }

  const orphans = findOrphans({ host: args.host, project: args.project, includeSelf: args.self });

  if (args.json) {
    const report = { found: orphans.length, killed: 0, failed: 0, orphans };
    if (args.kill) {
      for (const o of orphans) {
        const ok = killOne(o.pid, args.force);
        o.killed = ok;
        if (ok) report.killed++;
        else report.failed++;
      }
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  }

  if (orphans.length === 0) {
    if (!args.quiet) {
      const scope = args.host ? ` for host '${args.host}'` : '';
      console.log(`${green(G.ringOn)} no orphan host processes${scope}`);
    }
    return 0;
  }

  if (!args.kill) {
    console.log(`${yellow(`Found ${orphans.length} orphan process${orphans.length === 1 ? '' : 'es'}:`)}`);
    for (const o of orphans) {
      console.log(`  ${bold(String(o.pid).padStart(7))}  ${dim(o.host.padEnd(11))} ${dim('elapsed=' + o.elapsed.padEnd(12))} ${abbrevArgs(o.args)}`);
    }
    console.log('');
    console.log(`${dim('Re-run with')} --kill ${dim('to SIGTERM (or')} --kill --force ${dim('to SIGKILL).')}`);
    return 0;
  }

  let killed = 0;
  let failed = 0;
  for (const o of orphans) {
    const ok = killOne(o.pid, args.force);
    if (ok) { killed++; if (!args.quiet) console.log(`${dim('killed')} ${o.pid} ${dim('(' + o.host + ')')}`); }
    else   { failed++; console.error(`${red('failed')} ${o.pid} ${dim('(' + o.host + ')')} - ${dim('process gone or no permission')}`); }
  }
  if (!args.quiet) {
    const verb = args.force ? 'SIGKILL' : 'SIGTERM';
    console.log(`${green(G.ringOn)} ${verb} ${killed}/${orphans.length}${failed ? ` (${failed} failed)` : ''}`);
  }
  return failed > 0 ? 1 : 0;
};

// Exposed for run.cjs to call the predecessor-kill silently before spawn.
module.exports.preflightKill = function preflightKill({ host, project }) {
  const orphans = findOrphans({ host, project, includeSelf: false });
  let killed = 0;
  for (const o of orphans) {
    if (killOne(o.pid, /* force */ false)) killed++;
  }
  return { found: orphans.length, killed };
};

module.exports.__test__ = { HOST_MATCHERS, listProcs, findOrphans };
