/**
 * The bridge's `def:` command — an off-process driver registers a word def
 * straight into the band's DynDefs, so a runtime-contract check can put a
 * DETERMINISTIC cycleable def on a word without any model. Drives the real
 * CommandRunner through `startEventBridge` + `poll`, on this process's
 * own inject file (the bridge keys its files by pid); the file is removed
 * again in `finally`. Fixtures are synthetic on purpose.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { startEventBridge, type EventBridgeHandle } from './event-bridge';
import { DynDefs } from './state/dyn-defs';
import { HighlightState } from './state/highlight-state';
import { MockAdapter } from '../testing/mock-adapter';

let handle: EventBridgeHandle | null = null;
afterEach(() => { handle?.stop(); handle = null; });

function boot(text: string) {
  const adapter = new MockAdapter();
  adapter.pushText(text);
  const dynDefs = new DynDefs();
  handle = startEventBridge({
    adapter,
    dispatchKey: () => false,
    state: { hlState: new HighlightState(), dynDefs },
  });
  return { adapter, dynDefs, handle };
}

function send(h: EventBridgeHandle, line: string): void {
  fs.writeFileSync(h.paths.inject, line);
  h.poll();
}
/** the event BODIES the bridge wrote (each line is an envelope {ts, v, pid, body}) */
function events(h: EventBridgeHandle): Array<Record<string, unknown>> {
  return fs.readFileSync(h.paths.events, 'utf8').split('\n').filter(Boolean)
    .map((l) => (JSON.parse(l) as { body: Record<string, unknown> }).body);
}

describe('event bridge — def: seeds a word def deterministically', () => {
  it('registers [word, ...alternatives] at the word’s char span; index 0 = the word', () => {
    const { dynDefs, handle } = boot('we should zorbo this');
    send(handle!, 'def:2:{"alternatives":["zorbi","zorbu zorba"],"cueTip":"ALT-TIP zorbo"}');
    const def = dynDefs.get(2);
    expect(def).toBeDefined();
    expect(def!.originalWord).toBe('zorbo');
    expect(def!.alternatives).toEqual(['zorbo', 'zorbi', 'zorbu zorba']);
    expect(def!.currentIndex).toBe(0);
    expect([def!.spanStart, def!.spanEnd]).toEqual(['we should '.length, 'we should zorbo'.length]);
    expect(def!.cueTip).toBe('ALT-TIP zorbo');
    const seeded = events(handle!).find((e) => e.type === 'def.seeded') as { wordIndex: number; word: string } | undefined;
    expect(seeded).toMatchObject({ wordIndex: 2, word: 'zorbo' });
  });
  it('a word that is already alternatives[0] is not doubled', () => {
    const { dynDefs, handle } = boot('zorbo');
    send(handle!, 'def:0:{"alternatives":["zorbo","zorbi"]}');
    expect(dynDefs.get(0)!.alternatives).toEqual(['zorbo', 'zorbi']);
  });
  it('a bad index, missing alternatives or malformed JSON is a command.error, never a throw out of the poll', () => {
    const { dynDefs, handle } = boot('one two');
    send(handle!, 'def:7:{"alternatives":["x"]}');
    send(handle!, 'def:0:{"nope":1}');
    send(handle!, 'def:0:not json');
    expect(dynDefs.size).toBe(0);
    const errs = events(handle!).filter((e) => e.type === 'command.error');
    expect(errs).toHaveLength(3);
  });
});
