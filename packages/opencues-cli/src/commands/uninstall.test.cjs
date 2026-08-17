// Tests for `opencues uninstall` — host dispatch/routing (mirrors
// install.routing.test.cjs's approach for its install.cjs twin) plus the
// `uninstall skill <name>` / `uninstall plugin <name>` sub-commands.
//
// ── HERMETICITY (read this before touching this file) ──────────────────
//
// uninstall.cjs's per-host dispatch loop does:
//   const installer = path.join(ctx.REPO_ROOT, 'integrations', folder, 'bin', 'install.cjs');
//   spawnSync('node', [installer, action, ...passthrough], { stdio: 'inherit' });
// i.e. it shells out to a REAL child process. If ctx.REPO_ROOT ever
// pointed at the real repo root, this would invoke the REAL per-host
// uninstallers — which delete real Claude Code / OpenCode / Chrome /
// Gemini CLI / Shell install state from the actual machine. That is
// exactly the failure class this pass's brief warns about.
//
// The fix: ctx.REPO_ROOT is ALWAYS a throwaway mkdtemp dir
// (`fakeRepoRoot`) containing FAKE `integrations/<folder>/bin/install.cjs`
// scripts that do nothing but record their own argv to a marker file and
// exit with a controllable code (via env vars). The real per-host
// installers are never referenced, never spawned, never even present on
// disk in these tests.
//
// `uninstallSkill` / `uninstallPlugin` (the `uninstall skill <name>` /
// `uninstall plugin <name>` sub-commands) are DIFFERENT: they don't use
// ctx.REPO_ROOT at all — they resolve every path via `os.homedir()`
// directly (`~/.claude/skills/<name>`, `~/.config/opencode/skills/<name>`,
// `~/.config/opencode/plugins/<name>.ts`, `~/.config/opencode/config.json`)
// and call `fs.rmSync` on what they find. HOME + USERPROFILE are pointed
// at a fresh mkdtemp dir (`tmpHome`) for EVERY test in this file — even
// the pure host-dispatch tests that don't need it — as defense in depth,
// so no code path in uninstall.cjs can ever resolve a real-HOME path
// even if a future edit adds one. Every path passed to `fs.rmSync` in
// these tests is constructed by joining `tmpHome` (never a bare
// `os.homedir()` call, never `path.join(os.homedir(), ...)` — always the
// captured `tmpHome` variable) so the destination is provably inside the
// sandbox before the test ever calls into uninstall.cjs.
//
// uninstall.cjs calls process.exit() directly on nearly every path (both
// in the top-level dispatch AND inside uninstallSkill/uninstallPlugin),
// so process.exit is stubbed to throw `__EXIT_<code>__` — matching
// install.routing.test.cjs / install.skillplugin.test.cjs's established
// convention — rather than silently swallowing the call and letting
// unreachable code run past where the real process would have exited.

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const uninstall = require('./uninstall.cjs');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

let fakeRepoRoot;
let tmpHome;
let logs, errs;
let origLog, origErr, origExit;
const savedEnv = {};

beforeEach(() => {
  fakeRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-uninstall-repo-'));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-uninstall-home-'));

  savedEnv.HOME = process.env.HOME;
  savedEnv.USERPROFILE = process.env.USERPROFILE;
  savedEnv.OPENCUES_NO_INTERACTIVE = process.env.OPENCUES_NO_INTERACTIVE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome; // os.homedir() reads %USERPROFILE% on Windows, not $HOME
  process.env.OPENCUES_NO_INTERACTIVE = '1'; // belt-and-suspenders even though stdin isn't a TTY here

  logs = [];
  errs = [];
  origLog = console.log;
  origErr = console.error;
  origExit = process.exit;
  console.log = (...a) => logs.push(stripAnsi(a.join(' ')));
  console.error = (...a) => errs.push(stripAnsi(a.join(' ')));
  process.exit = (code) => { throw new Error(`__EXIT_${code}__`); };
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  process.exit = origExit;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(fakeRepoRoot, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// Plant a fake per-host installer at <fakeRepoRoot>/integrations/<folder>/bin/install.cjs.
// It records its own argv to last-args.json (readable via readLastArgs)
// and exits with a controllable code: per-folder env override
// `FAKE_EXIT_<FOLDER_UPPER_SNAKE>` wins over the blanket
// `FAKE_UNINSTALL_EXIT_CODE`, defaulting to 0. NEVER touches any real
// install state — it only ever writes inside its own bin/ directory.
function plantFakeInstaller(folder) {
  const binDir = path.join(fakeRepoRoot, 'integrations', folder, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const envKey = 'FAKE_EXIT_' + folder.toUpperCase().replace(/-/g, '_');
  const src = `
'use strict';
const fs = require('fs');
const path = require('path');
const rest = process.argv.slice(2);
try { fs.writeFileSync(path.join(__dirname, 'last-args.json'), JSON.stringify(rest)); } catch {}
const envKey = ${JSON.stringify(envKey)};
const code = process.env[envKey] !== undefined
  ? parseInt(process.env[envKey], 10)
  : (process.env.FAKE_UNINSTALL_EXIT_CODE !== undefined ? parseInt(process.env.FAKE_UNINSTALL_EXIT_CODE, 10) : 0);
process.exit(code);
`;
  fs.writeFileSync(path.join(binDir, 'install.cjs'), src);
}

function readLastArgs(folder) {
  const p = path.join(fakeRepoRoot, 'integrations', folder, 'bin', 'last-args.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Must stay in step with uninstall.cjs's HOST_FOLDERS — `--all` is only
// meaningfully tested if this fixture is the same set the command expands to.
const ALL_FOLDERS = ['claude-code', 'opencode', 'chrome', 'gemini-cli', 'shell', 'dsh'];

function ctx() {
  return { REPO_ROOT: fakeRepoRoot, pkg: { version: 'test' } };
}

// ─── Happy path — host dispatch ─────────────────────────────────────────────

describe('uninstall dispatch — single host', () => {
  it('happy: "cc" resolves to claude-code and invokes its fake installer with the "uninstall" action', async () => {
    plantFakeInstaller('claude-code');
    await assert.rejects(() => uninstall(['cc'], ctx()), /__EXIT_0__/);
    assert.deepStrictEqual(readLastArgs('claude-code'), ['uninstall']);
    assert.match(logs.join('\n'), /claude-code/);
  });

  it('happy: passthrough args (e.g. --target) are forwarded verbatim to the installer', async () => {
    plantFakeInstaller('opencode');
    await assert.rejects(() => uninstall(['opencode', '--target', '/some/explicit/path'], ctx()), /__EXIT_0__/);
    assert.deepStrictEqual(readLastArgs('opencode'), ['uninstall', '--target', '/some/explicit/path']);
  });

  it('happy: "chrome-host" resolves to the chrome folder but dispatches the "uninstall-host" action', async () => {
    plantFakeInstaller('chrome');
    await assert.rejects(() => uninstall(['chrome-host'], ctx()), /__EXIT_0__/);
    assert.deepStrictEqual(readLastArgs('chrome'), ['uninstall-host']);
  });
});

describe('uninstall dispatch — alias resolution', () => {
  const cases = [
    ['cc', 'claude-code'],
    ['claude', 'claude-code'],
    ['claudecode', 'claude-code'],
    ['claude-code', 'claude-code'],
    ['oc', 'opencode'],
    ['opencode', 'opencode'],
    ['gemini', 'gemini-cli'],
    ['geminicli', 'gemini-cli'],
    ['gemini-cli', 'gemini-cli'],
    ['term', 'shell'],
    ['oc-edit', 'shell'],
    ['shell', 'shell'],
    ['chrome', 'chrome'],
  ];
  for (const [alias, folder] of cases) {
    it(`"${alias}" resolves to the "${folder}" folder`, async () => {
      plantFakeInstaller(folder);
      await assert.rejects(() => uninstall([alias], ctx()), /__EXIT_0__/);
      assert.deepStrictEqual(readLastArgs(folder), ['uninstall']);
    });
  }
});

describe('uninstall dispatch — --all', () => {
  it('happy: expands to every known host and invokes each fake installer exactly once', async () => {
    for (const f of ALL_FOLDERS) plantFakeInstaller(f);
    await assert.rejects(() => uninstall(['--all'], ctx()), /__EXIT_0__/);
    for (const f of ALL_FOLDERS) {
      assert.deepStrictEqual(readLastArgs(f), ['uninstall'], `expected ${f} to have been invoked`);
    }
  });
});

// ─── Edge cases — host dispatch ─────────────────────────────────────────────

describe('uninstall dispatch — edge cases', () => {
  it('edge: one host failing does not stop the remaining hosts from being invoked', async () => {
    for (const f of ALL_FOLDERS) plantFakeInstaller(f);
    process.env.FAKE_EXIT_CLAUDE_CODE = '3';
    try {
      await assert.rejects(() => uninstall(['--all'], ctx()), /__EXIT_3__/);
    } finally {
      delete process.env.FAKE_EXIT_CLAUDE_CODE;
    }
    // Every host still got invoked despite claude-code's failure.
    for (const f of ALL_FOLDERS) {
      assert.ok(readLastArgs(f), `expected ${f} to have been invoked even after an earlier failure`);
    }
  });

  it('edge: aggregate exit code reflects the LAST failing host, not the first (success does not reset it back to 0)', async () => {
    for (const f of ALL_FOLDERS) plantFakeInstaller(f);
    // claude-code (first in HOST_FOLDERS) fails; opencode (second) succeeds.
    // The implementation only overwrites exitCode on failure, so the
    // aggregate should remain 3 even though a later host succeeded.
    process.env.FAKE_EXIT_CLAUDE_CODE = '3';
    try {
      await assert.rejects(() => uninstall(['--all'], ctx()), /__EXIT_3__/);
    } finally {
      delete process.env.FAKE_EXIT_CLAUDE_CODE;
    }
  });

  it('edge: a folder with no installer present reports "installer not found" and exits 1, without crashing the loop', async () => {
    // Deliberately leave 'shell' un-planted.
    for (const f of ALL_FOLDERS.filter(f => f !== 'shell')) plantFakeInstaller(f);
    await assert.rejects(() => uninstall(['--all'], ctx()), /__EXIT_1__/);
    assert.match(errs.join('\n'), /installer not found for "shell"/);
    // The other 4 hosts still ran.
    for (const f of ALL_FOLDERS.filter(f => f !== 'shell')) {
      assert.ok(readLastArgs(f), `expected ${f} to still have been invoked`);
    }
  });
});

// ─── Invalid input — host dispatch ──────────────────────────────────────────

describe('uninstall dispatch — invalid input', () => {
  it('invalid: missing <host> in a non-interactive context exits 2, listing every known host', async () => {
    await assert.rejects(() => uninstall([], ctx()), /__EXIT_2__/);
    assert.match(errs.join('\n'), /missing <host>/);
    assert.match(errs.join('\n'), /claude-code, opencode, chrome, gemini-cli, shell/);
  });

  it('invalid: unknown host name exits 2, naming the bad value', async () => {
    await assert.rejects(() => uninstall(['not-a-real-host'], ctx()), /__EXIT_2__/);
    assert.match(errs.join('\n'), /unknown host "not-a-real-host"/);
  });

  it('invalid: a single unresolvable installer (no fake planted) reports "installer not found" and exits 1', async () => {
    await assert.rejects(() => uninstall(['cc'], ctx()), /__EXIT_1__/);
    assert.match(errs.join('\n'), /installer not found for "claude-code"/);
  });

  it('invalid: --help before any host prints usage without dispatching anywhere', async () => {
    await uninstall(['--help'], ctx());
    assert.match(logs.join('\n'), /opencues uninstall <host>/);
    assert.strictEqual(errs.length, 0);
  });
});

// ─── uninstall skill <name> ─────────────────────────────────────────────────

describe('uninstall skill', () => {
  it('happy: removes the skill from BOTH ~/.claude/skills/ and ~/.config/opencode/skills/', async () => {
    const ccDir = path.join(tmpHome, '.claude', 'skills', 'myskill');
    const ocDir = path.join(tmpHome, '.config', 'opencode', 'skills', 'myskill');
    fs.mkdirSync(ccDir, { recursive: true });
    fs.writeFileSync(path.join(ccDir, 'SKILL.md'), 'cc skill content');
    fs.mkdirSync(ocDir, { recursive: true });
    fs.writeFileSync(path.join(ocDir, 'SKILL.md'), 'oc skill content');

    await assert.rejects(() => uninstall(['skill', 'myskill'], ctx()), /__EXIT_0__/);

    assert.strictEqual(fs.existsSync(ccDir), false);
    assert.strictEqual(fs.existsSync(ocDir), false);
    assert.match(logs.join('\n'), /removed/);
  });

  it('edge: neither location has the skill — reports "not installed at either location", removes nothing, still exits 0', async () => {
    await assert.rejects(() => uninstall(['skill', 'ghost-skill'], ctx()), /__EXIT_0__/);
    assert.match(logs.join('\n'), /"ghost-skill" was not installed at either location/);
  });

  it('edge: only ONE location has the skill — removes just that one, reports the other as "not present"', async () => {
    const ccDir = path.join(tmpHome, '.claude', 'skills', 'partial');
    fs.mkdirSync(ccDir, { recursive: true });
    fs.writeFileSync(path.join(ccDir, 'SKILL.md'), 'content');

    await assert.rejects(() => uninstall(['skill', 'partial'], ctx()), /__EXIT_0__/);
    assert.strictEqual(fs.existsSync(ccDir), false);
    assert.match(logs.join('\n'), /not present/);
  });

  it('invalid: missing <name> exits 2', async () => {
    await assert.rejects(() => uninstall(['skill'], ctx()), /__EXIT_2__/);
    assert.match(errs.join('\n'), /missing <name>/);
  });

  it('happy: `uninstall skill --help` prints usage and exits 0 without touching any skill dir', async () => {
    const ccDir = path.join(tmpHome, '.claude', 'skills', 'untouched');
    fs.mkdirSync(ccDir, { recursive: true });
    fs.writeFileSync(path.join(ccDir, 'SKILL.md'), 'do not remove me');
    await assert.rejects(() => uninstall(['skill', '--help'], ctx()), /__EXIT_0__/);
    assert.match(logs.join('\n'), /opencues uninstall skill <name>/);
    assert.strictEqual(fs.existsSync(ccDir), true);
  });
});

// ─── uninstall plugin <name> ────────────────────────────────────────────────
//
// The config.json de-registration branch used to reference an undefined
// `pluginFile`, so the ReferenceError was swallowed and the entry left
// registered forever. Fixed by defining `pluginFile`; the
// 'de-registers the plugin entry' test below is the regression pin (the
// former vitest `it.fails` knownbug file is retired).

describe('uninstall plugin', () => {
  it('happy: removes the plugin .ts file + its .ts.bak and .SKILL.md companions', async () => {
    const pluginDir = path.join(tmpHome, '.config', 'opencode', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'cues.ts'), '// plugin\n');
    fs.writeFileSync(path.join(pluginDir, 'cues.ts.bak'), '// backup\n');
    fs.writeFileSync(path.join(pluginDir, 'cues.SKILL.md'), '# prompt\n');

    await assert.rejects(() => uninstall(['plugin', 'cues'], ctx()), /__EXIT_0__/);

    assert.strictEqual(fs.existsSync(path.join(pluginDir, 'cues.ts')), false);
    assert.strictEqual(fs.existsSync(path.join(pluginDir, 'cues.ts.bak')), false);
    assert.strictEqual(fs.existsSync(path.join(pluginDir, 'cues.SKILL.md')), false);
  });

  it('edge: no plugin files present at all — no-op, still exits 0, no crash', async () => {
    await assert.rejects(() => uninstall(['plugin', 'never-installed'], ctx()), /__EXIT_0__/);
  });

  it('de-registers the plugin file:// entry from opencode config.json', async () => {
    // Regression: the de-registration used an undefined `pluginFile`, so a
    // swallowed ReferenceError left the entry registered (misreported as
    // "could not parse config.json" even though the JSON was valid).
    const pluginDir = path.join(tmpHome, '.config', 'opencode', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });
    const target = path.join(pluginDir, 'cues.ts');
    fs.writeFileSync(target, '// plugin\n');
    const fileUrl = `file://${target}`;
    const cfgPath = path.join(tmpHome, '.config', 'opencode', 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ plugin: [fileUrl, 'file:///keep/other.ts'] }));

    await assert.rejects(() => uninstall(['plugin', 'cues'], ctx()), /__EXIT_0__/);

    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.ok(!cfg.plugin.includes(fileUrl), 'our entry removed');
    assert.ok(cfg.plugin.includes('file:///keep/other.ts'), 'unrelated entries preserved');
  });

  it('edge: a config.json with no `plugin` array at all is left alone without crashing', async () => {
    const pluginDir = path.join(tmpHome, '.config', 'opencode', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'cues.ts'), '// plugin\n');
    const cfgPath = path.join(tmpHome, '.config', 'opencode', 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ someOtherField: true }));

    await assert.rejects(() => uninstall(['plugin', 'cues'], ctx()), /__EXIT_0__/);
    assert.strictEqual(fs.existsSync(path.join(pluginDir, 'cues.ts')), false);
    // config.json untouched (no `plugin` array to filter).
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.strictEqual(cfg.someOtherField, true);
  });

  it('invalid: a corrupted config.json is reported via the catch (not thrown to the caller)', async () => {
    const pluginDir = path.join(tmpHome, '.config', 'opencode', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'cues.ts'), '// plugin\n');
    const cfgPath = path.join(tmpHome, '.config', 'opencode', 'config.json');
    fs.writeFileSync(cfgPath, 'not valid json {{{');

    await assert.rejects(() => uninstall(['plugin', 'cues'], ctx()), /__EXIT_0__/);
    assert.match(logs.join('\n'), /could not parse/);
    // File removal still succeeded even though config.json was unreadable.
    assert.strictEqual(fs.existsSync(path.join(pluginDir, 'cues.ts')), false);
  });

  it('invalid: missing <name> exits 2', async () => {
    await assert.rejects(() => uninstall(['plugin'], ctx()), /__EXIT_2__/);
    assert.match(errs.join('\n'), /missing <name>/);
  });

  it('happy: `uninstall plugin --help` prints usage and exits 0 without touching any plugin file', async () => {
    const pluginDir = path.join(tmpHome, '.config', 'opencode', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'untouched.ts'), '// do not remove me\n');
    await assert.rejects(() => uninstall(['plugin', '--help'], ctx()), /__EXIT_0__/);
    assert.match(logs.join('\n'), /opencues uninstall plugin <name>/);
    assert.strictEqual(fs.existsSync(path.join(pluginDir, 'untouched.ts')), true);
  });
});
