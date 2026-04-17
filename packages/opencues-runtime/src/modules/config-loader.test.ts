import { describe, expect, it } from 'vitest';
import { ConfigLoader, parseOpenCuesMd } from './config-loader';
import { MockAdapter } from '../../testing/mock-adapter';

const SAMPLE_TIPS = JSON.stringify({
  domain: 'test',
  version: 1,
  concepts: [
    {
      id: 'greetings',
      words: {
        hello: { tip: 'say hi', alts: ['hi', 'hey', 'howdy'] },
        fast: { tip: 'moving quickly', alts: ['quick', 'rapid', 'swift'] },
      },
    },
  ],
});

describe('ConfigLoader', () => {
  it('loads tips JSON and builds a case-insensitive lookup', async () => {
    const adapter = new MockAdapter({ files: { '/tips.json': SAMPLE_TIPS } });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();

    expect(loader.loaded).toBe(true);
    expect(loader.cueMap.size).toBeGreaterThan(0);

    const hello = loader.lookup('hello');
    expect(hello).not.toBeNull();
    expect(hello!.alternatives).toContain('hi');

    // Case-insensitive
    expect(loader.lookup('HELLO')).not.toBeNull();
    expect(loader.lookup('Fast')?.alternatives).toContain('quick');
  });

  it('resolves gracefully when tips file is missing', async () => {
    const adapter = new MockAdapter({ files: {} });
    const loader = new ConfigLoader(adapter, { tipsPath: '/missing.json' });
    await loader.load();
    expect(loader.loaded).toBe(true);
    expect(loader.cueMap.size).toBe(0);
    expect(loader.lookup('hello')).toBeNull();
  });

  it('leaves map empty on parse failure, logs error', async () => {
    const adapter = new MockAdapter({ files: { '/bad.json': 'not valid json{{{' } });
    const loader = new ConfigLoader(adapter, { tipsPath: '/bad.json' });
    await loader.load();
    expect(loader.loaded).toBe(true);
    expect(loader.cueMap.size).toBe(0);
    expect(adapter.logs.some(l => l.level === 'error' && /parse failed/.test(l.msg))).toBe(true);
  });

  it('returns null from lookup when file-read capability absent', async () => {
    const adapter = new MockAdapter({ capabilities: [] });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    expect(loader.cueMap.size).toBe(0);
    expect(loader.lookup('hello')).toBeNull();
  });
});

describe('parseOpenCuesMd', () => {
  it('extracts top-level scalar settings, defaults the rest', () => {
    const md = `---
version: 1
voice-mode: inactive
debug-mode: on
tips-mode: off
cursor-navigate: active
output-format: rich markdown
display mode: split pane
settings:
  voice-mode:
    tip: ignored nested block
    values:
      active: x
---

# opencues.md
some prose
`;
    const state = parseOpenCuesMd(md);
    expect(state.voiceMode).toBe('inactive');
    expect(state.debugMode).toBe('on');
    expect(state.tipsMode).toBe('off');
    expect(state.cursorNavigate).toBe('active');
    expect(state.settings.get('output-format')).toBe('rich markdown');
    expect(state.settings.get('display mode')).toBe('split pane');
    expect(state.settings.has('settings')).toBe(false); // empty value skipped
    expect(state.settings.has('tip')).toBe(false); // indented = not top-level
  });

  it('returns defaults when no frontmatter', () => {
    const state = parseOpenCuesMd('# just markdown, no frontmatter');
    expect(state.voiceMode).toBe('active');
    expect(state.tipsMode).toBe('on');
    expect(state.debugMode).toBe('off');
    expect(state.cursorNavigate).toBe('inactive');
  });

  it('clamps unknown values to safe defaults', () => {
    const md = `---
voice-mode: muted
tips-mode: maybe
---`;
    const state = parseOpenCuesMd(md);
    expect(state.voiceMode).toBe('active'); // anything ≠ 'inactive' = active
    expect(state.tipsMode).toBe('on');      // anything ≠ 'off' = on
  });
});

describe('ConfigLoader expanded — cwd .md files', () => {
  const TIPS = JSON.stringify({
    domain: 't', version: 1,
    concepts: [{ id: 'a', words: { hello: { tip: 'hi', alts: ['hi'] } } }],
  });

  it('parses cues.md / controls.md / blanks.md frontmatter from cwd', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/tips.json': TIPS,
        '/proj/cues.md': '---\nname: my-cues\ndomain: test\nversion: 1\n---\n',
        '/proj/controls.md': '---\nname: my-controls\nversion: 1\n---\n',
        '/proj/blanks.md': '---\nname: my-blanks\nversion: 1\n---\n',
      },
    });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    expect(loader.cuesConfig?.frontmatter.name).toBe('my-cues');
    expect(loader.controlsConfig?.frontmatter.name).toBe('my-controls');
    expect(loader.blanksConfig?.frontmatter.name).toBe('my-blanks');
  });

  it('reads opencues.md state when present', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/tips.json': TIPS,
        '/proj/opencues.md': '---\nvoice-mode: inactive\ntips-mode: off\n---\n',
      },
    });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    expect(loader.opencuesState.voiceMode).toBe('inactive');
    expect(loader.opencuesState.tipsMode).toBe('off');
  });

  it('opencuesState is the default when opencues.md is missing', async () => {
    const adapter = new MockAdapter({ cwd: '/proj', files: { '/tips.json': TIPS } });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    expect(loader.opencuesState.voiceMode).toBe('active');
    expect(loader.opencuesState.tipsMode).toBe('on');
  });

  it('continues loading when one .md file is malformed', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/tips.json': TIPS,
        '/proj/cues.md': 'no frontmatter at all',
        '/proj/controls.md': '---\nname: ok\nversion: 1\n---\n',
      },
    });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    // controls.md still parses fine even though cues.md was odd.
    expect(loader.controlsConfig?.frontmatter.name).toBe('ok');
    expect(loader.cueMap.size).toBeGreaterThan(0); // tips JSON unaffected
  });
});

describe('ConfigLoader hot-reload', () => {
  it('maybeReload skips inside the debounce window', async () => {
    const adapter = new MockAdapter({ files: { '/tips.json': '{"concepts":[]}' } });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json', reloadDebounceMs: 1000 });
    await loader.load();
    const initial = adapter.logs.length;
    await loader.maybeReload();
    await loader.maybeReload();
    // No reload happened — log count unchanged.
    expect(adapter.logs.length).toBe(initial);
  });

  it('maybeReload does reload when debounce elapsed', async () => {
    const adapter = new MockAdapter({ files: { '/tips.json': '{"concepts":[]}' } });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json', reloadDebounceMs: 0 });
    await loader.load();
    const initial = adapter.logs.length;
    await loader.maybeReload();
    expect(adapter.logs.length).toBeGreaterThan(initial);
  });

  it('subscribe wires onTextChange → maybeReload', async () => {
    const adapter = new MockAdapter({ files: { '/tips.json': '{"concepts":[]}' } });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json', reloadDebounceMs: 0 });
    await loader.load();
    loader.subscribe();
    const initial = adapter.logs.length;
    adapter.pushText('triggered');
    // pushText fires onTextChange synchronously; maybeReload is async.
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(adapter.logs.length).toBeGreaterThan(initial);
  });
});
