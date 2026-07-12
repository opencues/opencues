// Tests for the OpenCode bootstrap patch source
// (patches/opencuesBootstrap.ts).
//
// This file is injection-glue: at install time setup.sh copies it
// into the cloned OpenCode fork with __OPENCUES_BAND__ substituted
// for a real adapter band, where its @opentui/@opencues/solid-js
// imports resolve against the fork's own node_modules. In THIS repo
// location none of that exists (the __OPENCUES_BAND__ specifier
// isn't even a real path pre-substitution), so every non-Node import
// is mocked below purely to make the module importable — we are NOT
// testing @opencues/runtime's `boot()`, OpenTUI, or solid-js
// reactivity here. Scope is the same as the guidance for the
// claude-code patch file: isolated, pure path/option-computation
// logic only (config-file path resolution, CUES-roots enumeration,
// user-blank-config discovery/dedup).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('@opentui/core', () => ({ RGBA: { fromValues: () => ({}), fromHex: () => ({}) } }));
vi.mock('@opencues/runtime/dist/adapters/oc/__OPENCUES_BAND__/boot', () => ({ boot: vi.fn() }));
vi.mock('@opencues/runtime/dist/src/adapter', () => ({}));
vi.mock('@opencues/runtime/dist/src/modules/mac-keyboard', () => ({ buildOpenTuiModifiers: vi.fn() }));
vi.mock('@opencues/runtime/dist/src/boot-common', () => ({
  createSourceReclassifier: () => ({ markRuntimeWrite: vi.fn(), reclassify: (_t: string, s: string) => s }),
}));
vi.mock('@opencues/runtime/dist/src/util/cell-width', () => ({ codeUnitsToCells: (_t: string, o: number) => o }));
vi.mock('@opencues/runtime/dist/src/blanks', () => ({
  createBlankInvoke: vi.fn(() => vi.fn()),
  createDefaultBlanksRegistry: vi.fn(() => new Map()),
}));
vi.mock('@opencues/runtime/dist/src/security/spawn-sandbox', () => ({
  validateScriptPath: vi.fn(() => ({ ok: true })),
  appendAuditLog: vi.fn(),
}));
vi.mock('@opencues/runtime/dist/src/security/sandbox-runner', () => ({ wrapWithBwrap: vi.fn(() => null) }));
vi.mock('@opencues/runtime/dist/src/user-blanks/registry', () => ({
  buildUserBlankRegistry: vi.fn(() => new Map()),
  createNativeLlmAdapter: vi.fn(() => ({})),
}));
vi.mock('@opencues/core', () => ({ parseSingleCueMd: vi.fn(() => ({ blanks: {} })) }));
vi.mock('solid-js', () => ({ createSignal: (v: unknown) => [() => v, vi.fn()] }));

// os.homedir() must be controllable regardless of platform (Windows'
// real os.homedir() reads USERPROFILE, not HOME — see the dedicated
// "HOME vs os.homedir() divergence" describe block below for why that
// distinction is load-bearing here). vi.hoisted keeps the mutable cell
// safe from the vi.mock hoist-to-top-of-file TDZ trap.
const { getFakeHomedir, setFakeHomedir } = vi.hoisted(() => {
  let fakeHomedir: string | null = null;
  return {
    getFakeHomedir: () => fakeHomedir,
    setFakeHomedir: (v: string | null) => { fakeHomedir = v; },
  };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => getFakeHomedir() ?? actual.homedir() };
});

describe('opencode bootstrap — pure path-resolution helpers', () => {
  const ORIGINAL_ENV = { ...process.env };
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'oc-bootstrap-test-home-'));
    process.env['HOME'] = tmpHome;
    setFakeHomedir(tmpHome);
    delete process.env['OPENCUES_HOME'];
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
    setFakeHomedir(null);
    vi.resetModules();
  });

  it('module loads without throwing once its heavy deps are mocked', async () => {
    await expect(import('./opencuesBootstrap')).resolves.toBeTruthy();
  });

  it('findOpenCuesMdPath uses OPENCUES_HOME when set', async () => {
    process.env['OPENCUES_HOME'] = '/custom/home';
    vi.resetModules();
    const mod = await import('./opencuesBootstrap');
    expect(mod.findOpenCuesMdPath()).toBe(path.join('/custom/home', 'OPENCUES.md'));
  });

  it('findOpenCuesMdPath falls back to $HOME/.cues/OPENCUES.md', async () => {
    const mod = await import('./opencuesBootstrap');
    expect(mod.findOpenCuesMdPath()).toBe(path.join(tmpHome, '.cues', 'OPENCUES.md'));
  });

  it('findIdentityMdPath / findNotesMdPath mirror the same OPENCUES_HOME override', async () => {
    process.env['OPENCUES_HOME'] = '/custom/home';
    vi.resetModules();
    const mod = await import('./opencuesBootstrap');
    expect(mod.findIdentityMdPath()).toBe(path.join('/custom/home', 'IDENTITY.md'));
    expect(mod.findNotesMdPath()).toBe(path.join('/custom/home', 'NOTES.md'));
  });

  it('findIdentityMdPath / findNotesMdPath fall back to $HOME/.cues', async () => {
    const mod = await import('./opencuesBootstrap');
    expect(mod.findIdentityMdPath()).toBe(path.join(tmpHome, '.cues', 'IDENTITY.md'));
    expect(mod.findNotesMdPath()).toBe(path.join(tmpHome, '.cues', 'NOTES.md'));
  });

  it('resolveTtsScript resolves under OPENCUES_HOME when set', async () => {
    process.env['OPENCUES_HOME'] = '/custom/home';
    vi.resetModules();
    const mod = await import('./opencuesBootstrap');
    expect(mod.resolveTtsScript()).toBe(path.join('/custom/home', 'scripts/speak.sh'));
  });

  it('resolveTtsScript falls back to $HOME/.cues/scripts/speak.sh', async () => {
    const mod = await import('./opencuesBootstrap');
    expect(mod.resolveTtsScript()).toBe(path.join(tmpHome, '.cues', 'scripts/speak.sh'));
  });

  it('getCuesRoots orders OPENCUES_HOME, <cwd>/.cues, then ~/.cues (os.homedir())', async () => {
    process.env['OPENCUES_HOME'] = '/env/home';
    vi.resetModules();
    const mod = await import('./opencuesBootstrap');
    const roots = mod.getCuesRoots();
    expect(roots[0]).toBe('/env/home');
    expect(roots[1]).toBe(path.join(process.cwd(), '.cues'));
    expect(roots[2]).toBe(path.join(tmpHome, '.cues'));
  });

  it('getCuesRoots omits OPENCUES_HOME entirely when unset', async () => {
    const mod = await import('./opencuesBootstrap');
    const roots = mod.getCuesRoots();
    expect(roots).toHaveLength(2);
    expect(roots[0]).toBe(path.join(process.cwd(), '.cues'));
  });
});

describe('opencode bootstrap — HOME vs os.homedir() divergence (documents a real inconsistency)', () => {
  const ORIGINAL_ENV = { ...process.env };
  let tmpHome: string;
  let tmpRealHomedir: string;

  beforeEach(() => {
    const osTmp = require('node:os').tmpdir();
    tmpHome = fs.mkdtempSync(path.join(osTmp, 'oc-bootstrap-home-'));
    tmpRealHomedir = fs.mkdtempSync(path.join(osTmp, 'oc-bootstrap-realhomedir-'));
    delete process.env['OPENCUES_HOME'];
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpRealHomedir, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
    setFakeHomedir(null);
    vi.resetModules();
  });

  // findOpenCuesMdPath/findIdentityMdPath/findNotesMdPath/resolveTtsScript
  // all read `process.env['HOME']` directly (falling back to the
  // literal string "~" if unset — see source). getCuesRoots and
  // _discoverUserBlankConfigs instead call `os.homedir()`. On a
  // platform (or shell setup) where `HOME` is set but disagrees with
  // the OS's own home-dir source (Windows uses USERPROFILE, not
  // HOME — a real-world case for e.g. Git Bash / WSL-adjacent
  // environments where HOME is exported but USERPROFILE differs),
  // OPENCUES.md is read from one directory while the CUES-roots
  // sandbox (spawnProcess path validation, user-blank discovery) is
  // rooted at a DIFFERENT one. That's a latent path-resolution split
  // brain, not merely a hypothetical — documented here rather than
  // fixed, per this pass's scope.
  it.fails('findOpenCuesMdPath and getCuesRoots agree on which "home" to use', async () => {
    process.env['HOME'] = tmpHome;
    setFakeHomedir(tmpRealHomedir); // os.homedir() disagrees with process.env.HOME
    vi.resetModules();
    const mod = await import('./opencuesBootstrap');

    const openCuesMdDir = path.dirname(mod.findOpenCuesMdPath()); // uses process.env.HOME
    const cuesRootDir = mod.getCuesRoots().at(-1); // uses os.homedir()

    // Expected (but NOT actual): both should resolve under the same
    // "home" concept. Actual: openCuesMdDir is under tmpHome while
    // cuesRootDir is under tmpRealHomedir — they diverge.
    expect(openCuesMdDir).toBe(cuesRootDir);
  });
});

describe('opencode bootstrap — _discoverUserBlankConfigs', () => {
  const ORIGINAL_ENV = { ...process.env };
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'oc-bootstrap-test-blanks-'));
    process.env['HOME'] = tmpHome;
    setFakeHomedir(tmpHome);
    delete process.env['OPENCUES_HOME'];
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
    setFakeHomedir(null);
    vi.resetModules();
  });

  it('returns an empty array when no blanks dir exists anywhere', async () => {
    const mod = await import('./opencuesBootstrap');
    expect(mod._discoverUserBlankConfigs()).toEqual([]);
  });

  it('discovers a blank config with an impl pointer', async () => {
    const cuesDir = path.join(tmpHome, '.cues');
    const blanksDir = path.join(cuesDir, 'blanks', 'demo');
    fs.mkdirSync(blanksDir, { recursive: true });
    fs.writeFileSync(
      path.join(blanksDir, 'BLANK.md'),
      '---\nname: demo\ntype: blank\nimpl: ./demo.js\n---\n',
    );
    const { parseSingleCueMd } = await import('@opencues/core');
    (parseSingleCueMd as any).mockReturnValue({ blanks: { demo: { impl: './demo.js' } } });

    const mod = await import('./opencuesBootstrap');
    const configs = mod._discoverUserBlankConfigs();
    expect(configs).toHaveLength(1);
    expect((configs[0] as any).impl).toBe('./demo.js');
  });

  it('dedupes roots that resolve to the same absolute path (cwd === HOME case)', async () => {
    // OPENCUES_HOME unset, so getCuesRoots would push both
    // <cwd>/.cues and <HOME>/.cues; when they resolve to the SAME
    // absolute path (a real launch scenario: user's cwd IS $HOME),
    // the blanks dir must not be double-counted.
    const originalCwd = process.cwd;
    process.cwd = () => tmpHome;
    try {
      const cuesDir = path.join(tmpHome, '.cues');
      const blanksDir = path.join(cuesDir, 'blanks', 'demo');
      fs.mkdirSync(blanksDir, { recursive: true });
      fs.writeFileSync(
        path.join(blanksDir, 'BLANK.md'),
        '---\nname: demo\ntype: blank\nimpl: ./demo.js\n---\n',
      );
      const { parseSingleCueMd } = await import('@opencues/core');
      (parseSingleCueMd as any).mockReturnValue({ blanks: { demo: { impl: './demo.js' } } });

      const mod = await import('./opencuesBootstrap');
      const configs = mod._discoverUserBlankConfigs();
      expect(configs).toHaveLength(1);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it('skips a blank dir whose BLANK.md has no impl pointer', async () => {
    const cuesDir = path.join(tmpHome, '.cues');
    const blanksDir = path.join(cuesDir, 'blanks', 'no-impl');
    fs.mkdirSync(blanksDir, { recursive: true });
    fs.writeFileSync(path.join(blanksDir, 'BLANK.md'), '---\nname: no-impl\ntype: blank\n---\n');
    const { parseSingleCueMd } = await import('@opencues/core');
    (parseSingleCueMd as any).mockReturnValue({ blanks: { 'no-impl': {} } });

    const mod = await import('./opencuesBootstrap');
    expect(mod._discoverUserBlankConfigs()).toEqual([]);
  });

  it('swallows a parse error for one blank and continues (no throw)', async () => {
    const cuesDir = path.join(tmpHome, '.cues');
    const blanksDir = path.join(cuesDir, 'blanks', 'broken');
    fs.mkdirSync(blanksDir, { recursive: true });
    fs.writeFileSync(path.join(blanksDir, 'BLANK.md'), 'not valid frontmatter at all');
    const { parseSingleCueMd } = await import('@opencues/core');
    (parseSingleCueMd as any).mockImplementation(() => { throw new Error('bad parse'); });

    const mod = await import('./opencuesBootstrap');
    expect(() => mod._discoverUserBlankConfigs()).not.toThrow();
    expect(mod._discoverUserBlankConfigs()).toEqual([]);
  });
});
