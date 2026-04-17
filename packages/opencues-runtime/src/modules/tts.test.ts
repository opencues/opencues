import { describe, expect, it, vi } from 'vitest';
import { TTS } from './tts';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

const TIPS = JSON.stringify({
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
  const adapter = new MockAdapter({ files: { '/tips.json': TIPS } });
  adapter.pushText(text);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
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

  it('speaks again when cycling to a different alt', async () => {
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
    // Cycle to "Tab"
    dynDefs.get(0)!.currentIndex = 1;
    tts.maybeSpeak({ text: 'Tab', cursor: 0, externalHighlights: [] });
    expect(spawnSpy).toHaveBeenCalledTimes(2);
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

  it('does not speak when spawn-process capability absent', async () => {
    const adapter = new MockAdapter({ capabilities: ['file-read'], files: { '/tips.json': TIPS } });
    adapter.pushText('ultrathink');
    const hlState = new HighlightState();
    hlState.activate(0, 'ultrathink');
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const tts = new TTS(adapter, hlState, new DynDefs(), loader, { scriptPath: '/speak.sh' });
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    expect(tts.maybeSpeak({ text: 'ultrathink', cursor: 0, externalHighlights: [] })).toBeNull();
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
