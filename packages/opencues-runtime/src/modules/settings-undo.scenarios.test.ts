// Scenario: `undo _` after a run of settings commands (live OpenCode,
// 2026-09-26). The person typed, each followed by `_`:
//
//   1. hii word voice mode on _    -> voice-mode active
//   2. use cerebras gemma _        -> blanks provider route (two scalars)
//   3. use gemma4 for cues _       -> cues provider route (two scalars)
//   4. use gemma for cues _        -> no verdict
//   5. voice mode on _             -> voice-mode active AGAIN (a no-op write)
//   6. undo the last change _      -> "undo x1 applied, 1 entry, 1 skipped [not-found]"
//
// and nothing changed. Step 5 had journaled a transaction whose scalar
// entry was active -> active: "undoing" it rewrote the same value and
// counted as applied, while its confirmation splice was already gone
// from the buffer. The contract pinned here: an undo of N undoes the
// last N REAL changes; a no-op write is never journaled.
//
// Recording runs through the REAL tap: the scripted core resolve calls
// the runtime's own `applyOpencuesScalar` wrapper (exactly what
// ConfigIntentSource does at emit time) before returning its
// config-intent result. OPENCUES.md is a synthetic MockAdapter file the
// stubbed `opencues set` writes, never the real ~/.cues.

import { describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SelectorSatelliteState } from '../state/selector-satellite';
import { SpanFillState } from '../state/span-fill';
import { UndoJournal } from '../state/undo-journal';
import { MockAdapter } from '../../testing/mock-adapter';
import type { BlankInvokeSpec, ProcessHandle } from '../adapter';

const OPENCUES_FILE = '/synthetic-home/OPENCUES.md';
const CUES_MD = `---
name: test-cues
domain: test
version: 1
---
`;

interface ScriptedResult {
  wordIndex: number;
  word: string;
  alternatives: string[];
  spanStart?: number;
  spanEnd?: number;
  source: string;
  priority: number;
  metadata?: Record<string, unknown>;
}

type ApplyScalar = (setting: string, value: string) => Promise<void>;

function setup(initial: Record<string, string>) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: { '/mock/CUES.md': JSON.stringify({ concepts: [] }), '/proj/CUES.md': CUES_MD },
  });
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
  const journal = new UndoJournal();

  // The persisted file: `opencues set <k> <v>` rewrites one line.
  const file = new Map<string, string>(Object.entries(initial));
  const render = (): string => [...file.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
  void adapter.writeFile(OPENCUES_FILE, render());
  (adapter as unknown as { blankInvoke: (spec: BlankInvokeSpec) => ProcessHandle | null }).blankInvoke = (spec) => {
    if (spec.blankName === 'opencues' && spec.action === 'set') {
      file.set(spec.args[0]!, spec.args[1]!);
      void adapter.writeFile(OPENCUES_FILE, render());
    }
    return { result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false }), kill: () => { /* no-op */ } };
  };

  let applyScalar: ApplyScalar | null = null;
  const resolver = new Resolver(
    adapter, new HighlightState(), new DynDefs(), loader,
    {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
      // Capture the runtime's real applyOpencuesScalar wrapper (the
      // undo tap) from the build options core would receive.
      resolverFactory: (_c: unknown, _b: unknown, opts: unknown) => {
        applyScalar = (opts as { applyOpencuesScalar: ApplyScalar }).applyOpencuesScalar;
        return [];
      },
    },
    new SpanFillState(),
    undefined, undefined, undefined,
    new SelectorSatelliteState(),
    undefined, undefined,
    journal,
  );

  // Scripted core: a step = the scalar writes the source performs at
  // emit time + the result it returns.
  let step: { writes: Array<[string, string]>; results: ScriptedResult[] } = { writes: [], results: [] };
  const scripted = {
    resolve: async () => {
      for (const [k, v] of step.writes) await applyScalar!(k, v);
      return { results: step.results };
    },
  };
  Object.defineProperty(resolver, '_resolver', { get: () => scripted, set: () => { /* keep scripted */ }, configurable: true });

  async function boot(): Promise<void> {
    await loader.load();
    resolver.rebuildResolver();
    expect(applyScalar).not.toBeNull();
    // Seed the in-memory settings from the synthetic file.
    for (const [k, v] of Object.entries(initial)) loader.applyOpenCuesScalar(k, v);
  }

  /** Type `text` (ending in `_`) and let the config-intent source answer. */
  async function settingsCommand(
    text: string,
    commandStart: number,
    writes: Array<[string, string]>,
    selector?: string,
    satellite?: string,
  ): Promise<void> {
    adapter.pushText(text);
    step = {
      writes,
      results: selector === undefined ? [] : [{
        wordIndex: 0, word: '_', alternatives: [selector],
        spanStart: commandStart, spanEnd: text.length,
        source: 'config-intent', priority: 94,
        metadata: { satelliteValue: satellite, displaySeparator: ' ', blankName: 'opencues', selectorBlank: true },
      }],
    };
    await resolver.resolveAndApply(adapter.getText());
  }

  async function action(verb: 'undo' | 'redo', count: number, text: string): Promise<void> {
    adapter.pushText(text);
    step = {
      writes: [],
      results: [{
        wordIndex: 0, word: '_', alternatives: [verb],
        spanStart: 0, spanEnd: text.length,
        source: 'config-intent', priority: 94,
        metadata: { undoAction: { action: verb, count, confidence: 0.91 } },
      }],
    };
    await resolver.resolveAndApply(adapter.getText());
  }

  async function fileText(): Promise<string> {
    return (await adapter.readFile(OPENCUES_FILE)) ?? '';
  }

  return { adapter, loader, journal, boot, settingsCommand, action, fileText };
}

const INITIAL = {
  'voice-mode': 'inactive',
  'blanks-llm-provider': 'groq',
  'blanks-llm-model': 'model-blanks-a',
  'cues-llm-provider': 'cerebras',
  'cues-llm-model': 'model-cues-a',
};

async function liveJourney(s: ReturnType<typeof setup>): Promise<void> {
  await s.boot();
  // 1. voice on (after some prose)
  await s.settingsCommand('hii word voice mode on _', 'hii word '.length,
    [['voice-mode', 'active']], 'voice-mode', 'active');
  // 2. blanks provider route
  await s.settingsCommand('use cerebras gemma _', 0,
    [['blanks-llm-provider', 'cerebras'], ['blanks-llm-model', 'model-blanks-b']], 'blanks-llm-provider', 'cerebras:model-blanks-b');
  // 3. cues provider route
  await s.settingsCommand('use gemma4 for cues _', 0,
    [['cues-llm-provider', 'ollama'], ['cues-llm-model', 'model-cues-b']], 'cues-llm-provider', 'ollama:model-cues-b');
  // 4. no verdict
  await s.settingsCommand('use gemma for cues _', 0, []);
  // 5. voice on again: already active, a no-op write
  await s.settingsCommand('voice mode on _', 0, [['voice-mode', 'active']], 'voice-mode', 'active');

  expect(await s.fileText()).toBe([
    'voice-mode: active',
    'blanks-llm-provider: cerebras',
    'blanks-llm-model: model-blanks-b',
    'cues-llm-provider: ollama',
    'cues-llm-model: model-cues-b',
  ].join('\n'));
}

describe('settings undo after a no-op write (live OpenCode, 2026-09-26)', () => {
  it('voice on, provider routes, a no-op voice write: undo x1 then undo x2 revert the last REAL changes; redo re-applies', async () => {
    const s = setup(INITIAL);
    await liveJourney(s);

    // The person cleared the buffer and typed the undo.
    await s.action('undo', 1, 'undo the last change _');
    // Step 3 (the cues route) is the last REAL change: both scalars revert.
    expect(await s.fileText()).toBe([
      'voice-mode: active',
      'blanks-llm-provider: cerebras',
      'blanks-llm-model: model-blanks-b',
      'cues-llm-provider: cerebras',
      'cues-llm-model: model-cues-a',
    ].join('\n'));
    expect(s.journal.recentApplyReport(60_000)?.appliedTransactions).toBe(1);

    await s.action('undo', 2, 'undo twice _');
    // Steps 2 and 1: the blanks route and voice-mode.
    expect(await s.fileText()).toBe([
      'voice-mode: inactive',
      'blanks-llm-provider: groq',
      'blanks-llm-model: model-blanks-a',
      'cues-llm-provider: cerebras',
      'cues-llm-model: model-cues-a',
    ].join('\n'));
    expect(s.loader.opencuesState.settings.get('voice-mode')).toBe('inactive');

    // Redo x1 re-applies the most recently undone change (voice on).
    await s.action('redo', 1, 'redo _');
    expect(await s.fileText()).toContain('voice-mode: active');
    expect(await s.fileText()).toContain('blanks-llm-provider: groq');

    // Nothing real is left to undo beyond voice: undo x1 reverts it, then
    // the journal is empty and the person is told so (never a silent no-op).
    await s.action('undo', 1, 'undo _');
    expect(await s.fileText()).toContain('voice-mode: inactive');
    await s.action('undo', 1, 'undo _');
    expect(s.adapter.getText()).toContain('[OpenCues: nothing to undo]');
  });

  it('a no-op settings write is never journaled', async () => {
    const s = setup(INITIAL);
    await s.boot();
    await s.settingsCommand('voice mode off _', 0, [['voice-mode', 'inactive']], 'voice-mode', 'inactive');
    expect(s.journal.undoDepth).toBe(0);
    await s.action('undo', 1, 'undo _');
    expect(s.adapter.getText()).toContain('[OpenCues: nothing to undo]');
    expect(await s.fileText()).toContain('voice-mode: inactive');
  });
});
