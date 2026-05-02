import { describe, expect, it, vi } from 'vitest';
import { TTS } from './tts';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter, wrapTipsAsCuesMd } from '../../testing/mock-adapter';

const TIPS = wrapTipsAsCuesMd({
  domain: 'test',
  version: 1,
  concepts: [
    {
      id: 'sayables',
      words: {
        ultrathink: { tip: 'Maximum reasoning', alts: ['Tab', 'deep thinking'], speak: true },
        opus: { tip: 'Most capable model', alts: ['sonnet'], speak: false },
      },
    },
  ],
});

async function setup(text: string) {
  const adapter = new MockAdapter({ files: { '/mock/cues.md': TIPS } });
  adapter.pushText(text);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter);
  await loader.load();
  const tts = new TTS(adapter, hlState, dynDefs, loader, { scriptPath: '/speak.sh' });
  tts.subscribe();
  // Spy on spawnProcess
  const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
  return { adapter, hlState, dynDefs, loader, tts, spawnSpy };
}

describe('TTS', () => {
  it('does not speak when highlight inactive', async () => {
    const { adapter, tts, spawnSpy } = await setup('ultrathink');
    const spoken = tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] });
    expect(spoken).toBeNull();
    expect(spawnSpy).not.toHaveBeenCalled();
    void adapter;
  });

  it('speaks the cue tip when active word has speak:true', async () => {
    const { hlState, tts, spawnSpy } = await setup('ultrathink');
    hlState.activate(0, 'ultrathink');
    const spoken = tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] });
    expect(spoken).toBe('Maximum reasoning');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledWith(expect.objectContaining({
      command: 'bash',
      args: ['/speak.sh', 'Maximum reasoning', '2'],
      detached: true,
    }));
  });

  it('does not speak when speak:false', async () => {
    const { hlState, tts, spawnSpy } = await setup('opus');
    hlState.activate(0, 'opus');
    expect(tts.maybeSpeak({ text: 'opus', cursor: 0, externalHighlights: [] })).toBeNull();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('does not speak when word has no cue map entry', async () => {
    const { hlState, tts, spawnSpy } = await setup('xyz');
    hlState.activate(0, 'xyz');
    expect(tts.maybeSpeak({ text: 'xyz', cursor: 0, externalHighlights: [] })).toBeNull();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('dedups consecutive renders with the same word', async () => {
    const { hlState, tts, spawnSpy } = await setup('ultrathink');
    hlState.activate(0, 'ultrathink');
    tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] });
    tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] });
    tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-speak when cycling alts on the same word', async () => {
    // Per-navigation dedup: cycling Up/Down keeps wordIndex constant,
    // so TTS stays silent. The user only hears the tip once per landing
    // on the word, not once per displayed alt.
    const { hlState, dynDefs, tts, spawnSpy } = await setup('ultrathink');
    hlState.activate(0, 'ultrathink');
    dynDefs.set(0, {
      originalWord: 'ultrathink',
      alternatives: ['ultrathink', 'Tab', 'deep thinking'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 10,
    });
    tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    // Cycle to "Tab" — wordIndex unchanged.
    dynDefs.get(0)!.currentIndex = 1;
    tts.maybeSpeak({ text: 'Tab', cursor: 0, externalHighlights: [] });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('resets dedup when highlight clears, allowing re-speak on next activate', async () => {
    const { hlState, tts, spawnSpy } = await setup('ultrathink');
    hlState.activate(0, 'ultrathink');
    tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    hlState.deactivate();
    tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] });
    hlState.activate(0, 'ultrathink');
    tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] });
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });

  it('does not speak when .opencuesrc sets voice-mode: inactive', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/proj/cues.md': wrapTipsAsCuesMd({
          domain: 'test', version: 1,
          concepts: [{ id: 'sayables', words: { ultrathink: { tip: 'Maximum reasoning', alts: ['Tab'], speak: true } } }],
        }),
        '/proj/.opencuesrc': 'voice-mode: inactive\n',
      },
    });
    adapter.pushText('ultrathink');
    const hlState = new HighlightState();
    hlState.activate(0, 'ultrathink');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/.opencuesrc' });
    await loader.load();
    const tts = new TTS(adapter, hlState, new DynDefs(), loader, { scriptPath: '/speak.sh' });
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    expect(tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] })).toBeNull();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('.opencuesrc `tts-rate:` overrides options.rate', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/proj/cues.md': wrapTipsAsCuesMd({
          domain: 'test', version: 1,
          concepts: [{ id: 'sayables', words: { ultrathink: { tip: 'Maximum reasoning', alts: ['Tab'], speak: true } } }],
        }),
        '/proj/.opencuesrc': 'tts-rate: 7\n',
      },
    });
    adapter.pushText('ultrathink');
    const hlState = new HighlightState();
    hlState.activate(0, 'ultrathink');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/.opencuesrc' });
    await loader.load();
    const tts = new TTS(adapter, hlState, new DynDefs(), loader, {
      scriptPath: '/speak.sh',
      rate: '2', // host default — should be overridden
    });
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] });
    expect(spawnSpy.mock.calls[0][0].args).toEqual(['/speak.sh', 'Maximum reasoning', '7']);
  });

  it('.opencuesrc `tts-script:` overrides options.scriptPath', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/proj/cues.md': wrapTipsAsCuesMd({
          domain: 'test', version: 1,
          concepts: [{ id: 'sayables', words: { ultrathink: { tip: 'Maximum reasoning', alts: ['Tab'], speak: true } } }],
        }),
        '/proj/.opencuesrc': 'tts-script: /custom/say.sh\n',
      },
    });
    adapter.pushText('ultrathink');
    const hlState = new HighlightState();
    hlState.activate(0, 'ultrathink');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/.opencuesrc' });
    await loader.load();
    const tts = new TTS(adapter, hlState, new DynDefs(), loader, { scriptPath: '/default/speak.sh' });
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] });
    expect(spawnSpy.mock.calls[0][0].args[0]).toBe('/custom/say.sh');
  });

  it('falls back to options.rate when cues.md has no `tts-rate:`', async () => {
    const { hlState, tts, spawnSpy } = await setup('ultrathink');
    hlState.activate(0, 'ultrathink');
    tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] });
    // setup() doesn't set rate option → fallback to '2'
    expect(spawnSpy.mock.calls[0][0].args[2]).toBe('2');
  });

  it('does not speak when spawn-process capability absent', async () => {
    const adapter = new MockAdapter({ capabilities: ['file-read'], files: { '/mock/cues.md': TIPS } });
    adapter.pushText('ultrathink');
    const hlState = new HighlightState();
    hlState.activate(0, 'ultrathink');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const tts = new TTS(adapter, hlState, new DynDefs(), loader, { scriptPath: '/speak.sh' });
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    expect(tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] })).toBeNull();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('speakFn is preferred over spawnProcess when supplied', async () => {
    const adapter = new MockAdapter({ files: { '/mock/cues.md': TIPS } });
    adapter.pushText('ultrathink');
    const hlState = new HighlightState();
    hlState.activate(0, 'ultrathink');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const speakFn = vi.fn();
    const tts = new TTS(adapter, hlState, new DynDefs(), loader, { scriptPath: '/speak.sh', speakFn });
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    const result = tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] });
    expect(result).toBe('Maximum reasoning');
    expect(speakFn).toHaveBeenCalledWith('Maximum reasoning', '2');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('speakFn works without scriptPath (sandboxed host case)', async () => {
    const adapter = new MockAdapter({ files: { '/mock/cues.md': TIPS } });
    adapter.pushText('ultrathink');
    const hlState = new HighlightState();
    hlState.activate(0, 'ultrathink');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const speakFn = vi.fn();
    const tts = new TTS(adapter, hlState, new DynDefs(), loader, { speakFn });
    expect(tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] })).toBe('Maximum reasoning');
    expect(speakFn).toHaveBeenCalled();
  });

  it('speakFn throws are logged and swallowed (does not break render loop)', async () => {
    const adapter = new MockAdapter({ files: { '/mock/cues.md': TIPS } });
    adapter.pushText('ultrathink');
    const hlState = new HighlightState();
    hlState.activate(0, 'ultrathink');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const speakFn = vi.fn(() => { throw new Error('audio device gone'); });
    const tts = new TTS(adapter, hlState, new DynDefs(), loader, { speakFn });
    const logSpy = vi.spyOn(adapter, 'log');
    expect(() => tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] })).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith('error', expect.stringContaining('TTS speakFn threw'), expect.any(Error));
  });

  it('.opencuesrc tts-rate flows to speakFn (same precedence as spawn path)', async () => {
    const adapter = new MockAdapter({
      files: {
        '/proj/cues.md': wrapTipsAsCuesMd({
          domain: 'test', version: 1,
          concepts: [{ id: 'sayables', words: { ultrathink: { tip: 'Maximum reasoning', alts: ['Tab'], speak: true } } }],
        }),
        '/proj/.opencuesrc': 'tts-rate: 5\n',
      },
      cwd: '/proj',
    });
    adapter.pushText('ultrathink');
    const hlState = new HighlightState();
    hlState.activate(0, 'ultrathink');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/.opencuesrc' });
    await loader.load();
    const speakFn = vi.fn();
    const tts = new TTS(adapter, hlState, new DynDefs(), loader, { speakFn, rate: '2' });
    tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] });
    expect(speakFn).toHaveBeenCalledWith('Maximum reasoning', '5');
  });
});
