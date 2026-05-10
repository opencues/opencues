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

  it('get(unknown) falls back to first setting tab-delimited (so satellite still spawns)', async () => {
    const { ctl } = makeBlank(SAMPLE_MD);
    expect(await ctl.get('not-a-setting')).toBe('voice-mode\tinactive');
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
});
