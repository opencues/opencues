// Tests for the shell integration's OpenCues wiring (src/bootstrap.ts).
//
// Like the OpenCode bootstrap, this file boots @opencues/runtime
// against a real OpenTUI textarea — none of that exists in this repo
// location (setup.sh cp's the built runtime dist into
// integrations/shell/node_modules/@opencues/ at install time; it is
// NOT an npm-resolved dependency here). Every @opencues/* import is
// mocked purely so the module can be imported; @opentui/core IS a
// real dependency of this package (pnpm-installed) but its RGBA/
// SyntaxStyle exports aren't needed for the pure logic under test, so
// it's mocked too, for a lighter/faster import.
//
// Scope: the same "isolated, pure path/option-computation logic"
// carve-out used for the OpenCode bootstrap tests — config-file path
// resolution, CUES-roots enumeration, and user-blank-config discovery
// — not the OpenTUI wiring or @opencues/runtime's `boot()` itself.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('@opentui/core', () => ({
  RGBA: { fromValues: () => ({}), fromHex: () => ({}) },
  SyntaxStyle: class {},
}));
vi.mock('@opencues/runtime/dist/adapters/shell/v1/boot', () => ({ boot: vi.fn() }));
vi.mock('@opencues/runtime/dist/src/modules/mac-keyboard', () => ({ buildOpenTuiModifiers: vi.fn() }));
vi.mock('@opencues/runtime/dist/src/boot-common', () => ({
  createSourceReclassifier: () => ({ markRuntimeWrite: vi.fn(), reclassify: (_t: string, s: string) => s }),
}));
vi.mock('@opencues/runtime/dist/src/util/cell-width', () => ({ codeUnitsToCells: (_t: string, o: number) => o }));
vi.mock('@opencues/runtime/dist/src/render-directives', () => ({
  inlineNoteDisplayText: (t: string) => t,
  inlineNoteBoxColumn: vi.fn(() => 0),
}));
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
vi.mock('./daemon-client', () => ({
  fetchSnapshot: vi.fn().mockResolvedValue(null),
  SnapshotCache: class {
    constructor(private snap: any) {}
    readFile() { return { hit: false }; }
    readDir() { return { hit: false }; }
    get version() { return this.snap.version; }
    get builtAt() { return this.snap.builtAt; }
  },
}));

// os.homedir() must be controllable regardless of platform — see the
// identical rationale in the opencode bootstrap test.
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

describe('shell bootstrap — pure path-resolution helpers', () => {
  const ORIGINAL_ENV = { ...process.env };
  const ORIGINAL_CWD = process.cwd;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'oc-shell-bootstrap-home-'));
    process.env['HOME'] = tmpHome;
    setFakeHomedir(tmpHome);
    delete process.env['OPENCUES_HOME'];
    delete process.env['OPENCUES_USER_CWD'];
    delete process.env['OPENCUES_OCEDITD_SOCK'];
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
    process.cwd = ORIGINAL_CWD;
    setFakeHomedir(null);
    vi.resetModules();
  });

  it('module loads without throwing once its heavy deps are mocked', async () => {
    await expect(import('./bootstrap')).resolves.toBeTruthy();
  });

  it('userCwd prefers OPENCUES_USER_CWD over process.cwd()', async () => {
    process.env['OPENCUES_USER_CWD'] = '/captured/caller/cwd';
    vi.resetModules();
    const mod = await import('./bootstrap');
    expect(mod.userCwd()).toBe('/captured/caller/cwd');
  });

  it('userCwd falls back to process.cwd() when OPENCUES_USER_CWD is unset', async () => {
    process.cwd = () => '/fallback/cwd';
    const mod = await import('./bootstrap');
    expect(mod.userCwd()).toBe('/fallback/cwd');
  });

  it('findOpenCuesMdPath uses OPENCUES_HOME when set', async () => {
    process.env['OPENCUES_HOME'] = '/custom/home';
    vi.resetModules();
    const mod = await import('./bootstrap');
    expect(mod.findOpenCuesMdPath()).toBe(path.join('/custom/home', 'OPENCUES.md'));
  });

  it('findOpenCuesMdPath falls back to os.homedir()/.cues/OPENCUES.md', async () => {
    const mod = await import('./bootstrap');
    expect(mod.findOpenCuesMdPath()).toBe(path.join(tmpHome, '.cues', 'OPENCUES.md'));
  });

  it('findIdentityMdPath / findNotesMdPath mirror the OPENCUES_HOME override', async () => {
    process.env['OPENCUES_HOME'] = '/custom/home';
    vi.resetModules();
    const mod = await import('./bootstrap');
    expect(mod.findIdentityMdPath()).toBe(path.join('/custom/home', 'IDENTITY.md'));
    expect(mod.findNotesMdPath()).toBe(path.join('/custom/home', 'NOTES.md'));
  });

  it('findIdentityMdPath / findNotesMdPath fall back to os.homedir()/.cues', async () => {
    const mod = await import('./bootstrap');
    expect(mod.findIdentityMdPath()).toBe(path.join(tmpHome, '.cues', 'IDENTITY.md'));
    expect(mod.findNotesMdPath()).toBe(path.join(tmpHome, '.cues', 'NOTES.md'));
  });

  it('resolveTtsScript resolves under OPENCUES_HOME when set', async () => {
    process.env['OPENCUES_HOME'] = '/custom/home';
    vi.resetModules();
    const mod = await import('./bootstrap');
    expect(mod.resolveTtsScript()).toBe(path.join('/custom/home', 'scripts/speak.sh'));
  });

  it('resolveTtsScript falls back to os.homedir()/.cues/scripts/speak.sh', async () => {
    const mod = await import('./bootstrap');
    expect(mod.resolveTtsScript()).toBe(path.join(tmpHome, '.cues', 'scripts/speak.sh'));
  });

  it('getCuesRoots orders OPENCUES_HOME, userCwd()/.cues, then os.homedir()/.cues', async () => {
    process.env['OPENCUES_HOME'] = '/env/home';
    process.env['OPENCUES_USER_CWD'] = '/captured/cwd';
    vi.resetModules();
    const mod = await import('./bootstrap');
    const roots = mod.getCuesRoots();
    expect(roots).toEqual(['/env/home', path.join('/captured/cwd', '.cues'), path.join(tmpHome, '.cues')]);
  });

  it('getCuesRoots omits OPENCUES_HOME entirely when unset', async () => {
    const mod = await import('./bootstrap');
    const roots = mod.getCuesRoots();
    expect(roots).toHaveLength(2);
  });
});

describe('shell bootstrap — HOME vs os.homedir() divergence (same bug class as opencode bootstrap)', () => {
  // findOpenCuesMdPath / findIdentityMdPath / findNotesMdPath /
  // resolveTtsScript all read `process.env['HOME'] ?? os.homedir()`.
  // getCuesRoots and _discoverUserBlankConfigs instead call
  // `os.homedir()` directly, with no HOME-env check at all. On a
  // setup where HOME is exported but disagrees with the OS's own
  // home-dir source (Windows' real os.homedir() reads USERPROFILE,
  // not HOME), OPENCUES.md is read from one directory while the
  // CUES-roots sandbox (spawnProcess path validation, user-blank
  // discovery) is rooted at a different one. Same latent
  // split-brain documented for integrations/opencode/patches/
  // opencuesBootstrap.ts's getCuesRoots — not fixed here, just
  // pinned per this pass's scope (see root task rules).
  const ORIGINAL_ENV = { ...process.env };
  let tmpHome: string;
  let tmpRealHomedir: string;

  beforeEach(() => {
    const osTmp = require('node:os').tmpdir();
    tmpHome = fs.mkdtempSync(path.join(osTmp, 'oc-shell-bootstrap-consistency-home-'));
    tmpRealHomedir = fs.mkdtempSync(path.join(osTmp, 'oc-shell-bootstrap-consistency-real-'));
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

  it.fails('findOpenCuesMdPath and getCuesRoots agree on which "home" to use, even when process.env.HOME and os.homedir() disagree', async () => {
    process.env['HOME'] = tmpHome;
    setFakeHomedir(tmpRealHomedir); // os.homedir() disagrees with process.env.HOME
    vi.resetModules();
    const mod = await import('./bootstrap');

    const openCuesMdDir = path.dirname(mod.findOpenCuesMdPath()); // uses process.env.HOME
    const cuesRootDir = mod.getCuesRoots().at(-1); // uses os.homedir() only

    // Expected (but NOT actual): both should resolve under the same
    // "home" concept. Actual: openCuesMdDir lands under tmpHome while
    // cuesRootDir lands under tmpRealHomedir.
    expect(openCuesMdDir).toBe(cuesRootDir);
  });
});

describe('shell bootstrap — _discoverUserBlankConfigs', () => {
  const ORIGINAL_ENV = { ...process.env };
  const ORIGINAL_CWD = process.cwd;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'oc-shell-bootstrap-blanks-'));
    process.env['HOME'] = tmpHome;
    setFakeHomedir(tmpHome);
    delete process.env['OPENCUES_HOME'];
    delete process.env['OPENCUES_USER_CWD'];
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
    process.cwd = ORIGINAL_CWD;
    setFakeHomedir(null);
    vi.resetModules();
  });

  it('returns an empty array when no blanks dir exists anywhere', async () => {
    const mod = await import('./bootstrap');
    expect(mod._discoverUserBlankConfigs()).toEqual([]);
  });

  it('discovers a blank config with an impl pointer', async () => {
    const blanksDir = path.join(tmpHome, '.cues', 'blanks', 'demo');
    fs.mkdirSync(blanksDir, { recursive: true });
    fs.writeFileSync(path.join(blanksDir, 'BLANK.md'), '---\nname: demo\ntype: blank\nimpl: ./demo.js\n---\n');
    const { parseSingleCueMd } = await import('@opencues/core');
    (parseSingleCueMd as any).mockReturnValue({ blanks: { demo: { impl: './demo.js' } } });

    const mod = await import('./bootstrap');
    const configs = mod._discoverUserBlankConfigs();
    expect(configs).toHaveLength(1);
    expect((configs[0] as any).impl).toBe('./demo.js');
  });

  it('skips a blank dir whose BLANK.md has no impl pointer', async () => {
    const blanksDir = path.join(tmpHome, '.cues', 'blanks', 'no-impl');
    fs.mkdirSync(blanksDir, { recursive: true });
    fs.writeFileSync(path.join(blanksDir, 'BLANK.md'), '---\nname: no-impl\ntype: blank\n---\n');
    const { parseSingleCueMd } = await import('@opencues/core');
    (parseSingleCueMd as any).mockReturnValue({ blanks: { 'no-impl': {} } });

    const mod = await import('./bootstrap');
    expect(mod._discoverUserBlankConfigs()).toEqual([]);
  });

  it('swallows a parse error for one blank and continues (no throw)', async () => {
    const blanksDir = path.join(tmpHome, '.cues', 'blanks', 'broken');
    fs.mkdirSync(blanksDir, { recursive: true });
    fs.writeFileSync(path.join(blanksDir, 'BLANK.md'), 'not valid frontmatter at all');
    const { parseSingleCueMd } = await import('@opencues/core');
    (parseSingleCueMd as any).mockImplementation(() => { throw new Error('bad parse'); });

    const mod = await import('./bootstrap');
    expect(() => mod._discoverUserBlankConfigs()).not.toThrow();
  });

  it('dedupes roots that resolve to the same absolute path (userCwd() === HOME case)', async () => {
    process.env['OPENCUES_USER_CWD'] = tmpHome;
    vi.resetModules();
    const blanksDir = path.join(tmpHome, '.cues', 'blanks', 'demo');
    fs.mkdirSync(blanksDir, { recursive: true });
    fs.writeFileSync(path.join(blanksDir, 'BLANK.md'), '---\nname: demo\ntype: blank\nimpl: ./demo.js\n---\n');
    const { parseSingleCueMd } = await import('@opencues/core');
    (parseSingleCueMd as any).mockReturnValue({ blanks: { demo: { impl: './demo.js' } } });

    const mod = await import('./bootstrap');
    expect(mod._discoverUserBlankConfigs()).toHaveLength(1);
  });
});

describe('shell bootstrap — daemon snapshot cache wiring at import time', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it('does not call fetchSnapshot when OPENCUES_OCEDITD_SOCK is unset', async () => {
    delete process.env['OPENCUES_OCEDITD_SOCK'];
    vi.resetModules();
    const daemonClient = await import('./daemon-client');
    await import('./bootstrap');
    expect(daemonClient.fetchSnapshot).not.toHaveBeenCalled();
  });

  it('calls fetchSnapshot with the socket path when OPENCUES_OCEDITD_SOCK is set', async () => {
    process.env['OPENCUES_OCEDITD_SOCK'] = '/tmp/oc-editd-test.sock';
    vi.resetModules();
    const daemonClient = await import('./daemon-client');
    await import('./bootstrap');
    expect(daemonClient.fetchSnapshot).toHaveBeenCalledWith('/tmp/oc-editd-test.sock');
  });

  it('does not throw when fetchSnapshot rejects (silent fallback to direct fs)', async () => {
    process.env['OPENCUES_OCEDITD_SOCK'] = '/tmp/oc-editd-test.sock';
    vi.resetModules();
    vi.doMock('./daemon-client', () => ({
      fetchSnapshot: vi.fn().mockRejectedValue(new Error('daemon unreachable')),
      SnapshotCache: class {},
    }));
    try {
      await expect(import('./bootstrap')).resolves.toBeTruthy();
    } finally {
      vi.doUnmock('./daemon-client');
    }
  });
});
