import { describe, it, expect, vi } from 'vitest';
import { OpenCuesSettingsControl } from './opencues-settings';

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

function makeControl(initial: string): {
  ctl: OpenCuesSettingsControl;
  storage: { value: string };
  reads: number;
  writes: number;
} {
  const storage = { value: initial };
  let reads = 0;
  let writes = 0;
  const readFile = vi.fn(async () => { reads += 1; return storage.value; });
  const writeFile = vi.fn(async (content: string) => { writes += 1; storage.value = content; });
  const ctl = new OpenCuesSettingsControl({ readFile, writeFile });
  return { ctl, storage, get reads() { return reads; }, get writes() { return writes; } };
}

describe('OpenCuesSettingsControl', () => {
  it('get() with no keyword returns "<firstSetting>\\t<currentValue>"', async () => {
    const { ctl } = makeControl(SAMPLE_MD);
    expect(await ctl.get()).toBe('voice-mode\tinactive');
  });

  it('get(keyword) returns the current value for that setting', async () => {
    const { ctl } = makeControl(SAMPLE_MD);
    expect(await ctl.get('debug-mode')).toBe('off');
    expect(await ctl.get('tips-mode')).toBe('on');
  });

  it('get(unknown) falls back to first setting tab-delimited (so satellite still spawns)', async () => {
    const { ctl } = makeControl(SAMPLE_MD);
    expect(await ctl.get('not-a-setting')).toBe('voice-mode\tinactive');
  });

  it('set(value, keyword) rewrites the matching line in opencues.md', async () => {
    const { ctl, storage } = makeControl(SAMPLE_MD);
    await ctl.set('active', 'voice-mode');
    expect(storage.value).toContain('voice-mode: active');
    // Other lines untouched.
    expect(storage.value).toContain('debug-mode: off');
    expect(storage.value).toContain('tips-mode: on');
  });

  it('set is a no-op when the setting line does not exist', async () => {
    const { ctl, storage, writes } = makeControl(SAMPLE_MD);
    await ctl.set('whatever', 'unknown-key');
    expect(storage.value).toBe(SAMPLE_MD);
    // No-op skips writeFile entirely (avoids touching mtime when nothing
    // changed — popups + hot-reload watchers don't get false-positives).
    expect(writes).toBe(0);
  });

  it('set is a no-op when keyword is missing', async () => {
    const { ctl, writes } = makeControl(SAMPLE_MD);
    await ctl.set('value');
    expect(writes).toBe(0);
  });

  it('returns "" when readFile yields null (file missing)', async () => {
    const ctl = new OpenCuesSettingsControl({
      readFile: async () => null,
      writeFile: async () => { /* unused */ },
    });
    expect(await ctl.get()).toBe('');
    expect(await ctl.get('voice-mode')).toBe('');
  });

  it('preserves surrounding whitespace + frontmatter delimiters on set', async () => {
    const { ctl, storage } = makeControl(SAMPLE_MD);
    await ctl.set('on', 'debug-mode');
    expect(storage.value.startsWith('---\n')).toBe(true);
    expect(storage.value.endsWith('---\n')).toBe(true);
  });

  it("first-setting probe ignores the inline frontmatter scalar lines and finds the first nested key", async () => {
    // Frontmatter has voice-mode/debug-mode/tips-mode as inline values
    // at the top, then `settings:` block lists them indented. The walker
    // should pick the first INDENTED key under `settings:`, not the
    // top-level scalars.
    const { ctl } = makeControl(SAMPLE_MD);
    expect((await ctl.get()).startsWith('voice-mode\t')).toBe(true);
  });
});
