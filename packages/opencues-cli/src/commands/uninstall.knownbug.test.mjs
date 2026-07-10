// Known-bug pin for `opencues uninstall plugin <name>` (uninstall.cjs's
// `uninstallPlugin` function).
//
// uninstallPlugin's config.json de-registration step (uninstall.cjs, in
// the `if (Array.isArray(cfg.plugin))` block) does:
//   const fileUrl = `file://${pluginFile}`;
// but `pluginFile` is never declared anywhere in the function's (or the
// module's) scope — only `name`, `pluginDir`, and `companions` are. This
// throws `ReferenceError: pluginFile is not defined`, which is caught by
// the surrounding `catch (err)` block (added for JSON.parse failures) and
// reported as `could not parse ${cfgPath}: ${err.message}` — a
// misleading message, since the JSON parsed FINE; the config.json is
// simply never updated and the plugin entry is left registered forever.
//
// Expected: after `opencues uninstall plugin <name>`, the plugin's
// `file://<path>` entry is removed from `~/.config/opencode/config.json`'s
// `plugin: [...]` array (mirroring install.cjs's `installPlugin`, which
// correctly uses `target` for the same computation — see
// packages/opencues-cli/src/commands/install.cjs:964).
// Actual: the entry is left in config.json untouched, and a misleading
// "could not parse" message is printed even though config.json is valid
// JSON.
//
// Proposed fix direction: rename `pluginFile` to `target` (the actual
// variable holding the plugin's absolute path in this function), matching
// install.cjs's `installPlugin` naming.
//
// This is a vitest file (not node:test) specifically so `it.fails` can
// pin the bug — see init.knownbug.test.mjs / blank-fill.test.ts for the
// established it.fails convention this follows. Not picked up by this
// package's `node --test src/commands/*.test.cjs` script (vitest cannot
// even be `require()`d from a .cjs file — confirmed empirically); run
// explicitly with `npx vitest run src/commands/uninstall.knownbug.test.mjs`.
//
// Hermeticity: HOME + USERPROFILE point at a fresh mkdtemp dir for every
// test (uninstallPlugin resolves everything via os.homedir()) —
// os.homedir() reads %USERPROFILE% on Windows, not $HOME, so both are
// always set together and restored afterward. process.exit is stubbed to
// throw so uninstallPlugin's terminal `process.exit(0)` doesn't kill the
// vitest worker.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const uninstall = require('./uninstall.cjs');

let tmpHome;
let realHome, realUserProfile;
let origExit, origLog;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-uninstall-knownbug-'));
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  origExit = process.exit;
  origLog = console.log;
  console.log = () => {};
  process.exit = (code) => { throw new Error(`__EXIT_${code}__`); };
});

afterEach(() => {
  process.exit = origExit;
  console.log = origLog;
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('known bug: uninstall.cjs uninstallPlugin references undefined `pluginFile`', () => {
  it.fails('should remove the plugin entry from opencode config.json plugin array', async () => {
    const pluginDir = path.join(tmpHome, '.config', 'opencode', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });
    const target = path.join(pluginDir, 'cues.ts');
    fs.writeFileSync(target, '// plugin source\n');
    const cfgPath = path.join(pluginDir, '..', 'config.json');
    const fileUrl = `file://${target}`;
    fs.writeFileSync(cfgPath, JSON.stringify({ plugin: [fileUrl] }));

    try {
      await uninstall(['plugin', 'cues'], { REPO_ROOT: tmpHome });
    } catch (e) {
      if (!/^__EXIT_/.test(e.message)) throw e;
    }

    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    // This is the assertion that currently fails: the ReferenceError
    // thrown inside the try/catch means cfg.plugin is never filtered,
    // so the stale file:// entry survives uninstall.
    expect(cfg.plugin).not.toContain(fileUrl);
  });
});
