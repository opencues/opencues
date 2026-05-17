import { describe, it, expect, vi } from 'vitest';
import { OpenCuesSettingsBlank } from './opencues-settings';

const SAMPLE_MD = `---
version: 1
voice-mode: inactive
debug-mode: off
tips-mode: on
settings:
  voice-mode:
    tip: Gates TTS globally
    values:
      active: TTS reads tips aloud
      inactive: TTS is silenced
  debug-mode:
    tip: Toggle debug logging
    values:
      on: Verbose
      off: Quiet
---
`;

function makeBlank(initial: string): {
  ctl: OpenCuesSettingsBlank;
  storage: { value: string };
  reads: number;
  writes: number;
} {
  const storage = { value: initial };
  let reads = 0;
  let writes = 0;
  const readFile = vi.fn(async () => { reads += 1; return storage.value; });
  const writeFile = vi.fn(async (content: string) => { writes += 1; storage.value = content; });
  const ctl = new OpenCuesSettingsBlank({ readFile, writeFile });
  return { ctl, storage, get reads() { return reads; }, get writes() { return writes; } };
}

describe('OpenCuesSettingsBlank', () => {
  it('get() with no keyword returns "<firstSetting>\\t<currentValue>"', async () => {
    const { ctl } = makeBlank(SAMPLE_MD);
    expect(await ctl.get()).toBe('voice-mode\tinactive');
  });

  it('get(keyword) returns the current value for that setting', async () => {
    const { ctl } = makeBlank(SAMPLE_MD);
    expect(await ctl.get('debug-mode')).toBe('off');
    expect(await ctl.get('tips-mode')).toBe('on');
  });

  it('get(unknown-to-registry) falls through to first-setting tab-delimited (BlankFill init path)', async () => {
    // BlankFill's keyword detection sometimes synthesises a multi-
    // word keyword like 'opencues settings' (from the trigger phrase)
    // that isn't a single scalar name. For those genuinely-unknown
    // keywords the satellite init fallback IS the right behaviour —
    // populates `<firstSetting>\t<value>` so the satellite has
    // something to spawn.
    //
    // The bug this fixes (separately) is the REGISTRY-known case —
    // see the next test. Keep both paths green.
    const { ctl } = makeBlank(SAMPLE_MD);
    expect(await ctl.get('not-a-real-setting')).toBe('voice-mode\tinactive');
  });

  it('set(setting, value) rewrites the matching line in CUES.md', async () => {
    // NB: arg order is (settingName, value) per the selector/satellite
    // cycling convention — see opencues-settings.ts comment.
    const { ctl, storage } = makeBlank(SAMPLE_MD);
    await ctl.set('voice-mode', 'active');
    expect(storage.value).toContain('voice-mode: active');
    // Other lines untouched.
    expect(storage.value).toContain('debug-mode: off');
    expect(storage.value).toContain('tips-mode: on');
  });

  it('set is a no-op when the setting line does not exist', async () => {
    const { ctl, storage, writes } = makeBlank(SAMPLE_MD);
    await ctl.set('unknown-key', 'whatever');
    expect(storage.value).toBe(SAMPLE_MD);
    // No-op skips writeFile entirely (avoids touching mtime when nothing
    // changed — popups + hot-reload watchers don't get false-positives).
    expect(writes).toBe(0);
  });

  it('set is a no-op when value is missing', async () => {
    const { ctl, writes } = makeBlank(SAMPLE_MD);
    await ctl.set('voice-mode');
    expect(writes).toBe(0);
  });

  it('returns "" when readFile yields null (file missing)', async () => {
    const ctl = new OpenCuesSettingsBlank({
      readFile: async () => null,
      writeFile: async () => { /* unused */ },
    });
    expect(await ctl.get()).toBe('');
    expect(await ctl.get('voice-mode')).toBe('');
  });

  // Regression contract: an empty-string read result (e.g. a 0-byte
  // ~/.cues/CUES.md left by an interrupted seed) is functionally
  // equivalent to "no file" — the blank silently no-ops on both `get`
  // and `set`. This is intentional (it avoids fabricating a settings
  // schema that the host doesn't know about), but it means the host MUST
  // seed non-empty content before the blank is used. install.cjs's
  // seed-configs treats 0-byte files as missing + setup.sh's section
  // 7a-bis re-seeds them; without those, `opencues ___` / `config ___`
  // blank-fills look broken on every native host. See FAQ.md "Does init
  // scaffold CUES.md?" + docs/features/config-search-paths.md.
  it('returns "" when readFile yields empty string (0-byte file)', async () => {
    const ctl = new OpenCuesSettingsBlank({
      readFile: async () => '',
      writeFile: async () => { /* unused */ },
    });
    expect(await ctl.get()).toBe('');
    expect(await ctl.get('voice-mode')).toBe('');
  });

  it('set() is a no-op when readFile yields null (no file to rewrite)', async () => {
    const writeFile = vi.fn(async () => { /* unused */ });
    const ctl = new OpenCuesSettingsBlank({
      readFile: async () => null,
      writeFile,
    });
    await ctl.set('voice-mode', 'active');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('set() is a no-op when readFile yields empty string (0-byte file)', async () => {
    const writeFile = vi.fn(async () => { /* unused */ });
    const ctl = new OpenCuesSettingsBlank({
      readFile: async () => '',
      writeFile,
    });
    await ctl.set('voice-mode', 'active');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('preserves surrounding whitespace + frontmatter delimiters on set', async () => {
    const { ctl, storage } = makeBlank(SAMPLE_MD);
    await ctl.set('debug-mode', 'on');
    expect(storage.value.startsWith('---\n')).toBe(true);
    expect(storage.value.endsWith('---\n')).toBe(true);
  });

  it("first-setting probe ignores the inline frontmatter scalar lines and finds the first nested key", async () => {
    // Frontmatter has voice-mode/debug-mode/tips-mode as inline values
    // at the top, then `settings:` block lists them indented. The walker
    // should pick the first INDENTED key under `settings:`, not the
    // top-level scalars.
    const { ctl } = makeBlank(SAMPLE_MD);
    expect((await ctl.get()).startsWith('voice-mode\t')).toBe(true);
  });

  // Regression: when the caller asks `get(keyword)` for a scalar that
  // exists in the @opencues/core FEATURES registry but the user's
  // OPENCUES.md doesn't have a line for it (just defaults apply), the
  // contract is "return the registry default value for THIS keyword."
  // Pre-fix: the unknown-keyword path fell through to
  // "<firstSetting>\t<value>", which the cycling code at
  // cycling.ts:218 spliced into the satellite slot — producing
  // `<askedSetting> <other>\t<v>` in the buffer (tab renders as
  // multiple spaces in most hosts). Canonical symptom:
  // "blank-trigger-mode fluid-blank-mode    on" after cycling the
  // selector to a registry-only setting.
  it('get(keyword) returns registry default when keyword absent from file (no tab leak)', async () => {
    const md = `---\nfluid-blank-mode: on\n---\n`;
    const ctl = new OpenCuesSettingsBlank({
      readFile: async () => md,
      writeFile: async () => { /* unused */ },
    });
    const got = await ctl.get('blank-trigger-mode');
    expect(got).toBe('immediate');
    expect(got).not.toContain('\t');
    expect(got).not.toContain('fluid-blank-mode');
  });

  it('get(unknown-to-everything) falls through to registry first-setting init', async () => {
    // File has only fluid-blank-mode. Registry knows many more. An
    // unknown-to-registry keyword falls through to satellite-init
    // shape, which finds the first cyclable setting in the registry
    // (fluid-blank-mode) and returns it tab-delimited.
    const md = `---\nfluid-blank-mode: on\n---\n`;
    const ctl = new OpenCuesSettingsBlank({
      readFile: async () => md,
      writeFile: async () => { /* unused */ },
    });
    const result = await ctl.get('not-a-real-setting');
    expect(result).toContain('\t');
    expect(result.split('\t')[0]).toMatch(/^[a-z][a-z0-9-]*$/);  // first-setting name
  });
});
