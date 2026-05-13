// Scenario tests for MarkdownRender: trigger-on-LLM, invalidate-on-user,
// blank-slot suppression, integration with the render pipeline.

import { describe, expect, it, beforeEach } from 'vitest';
import { MarkdownRender } from './markdown-render';
import type { HostAdapter, RenderContext, TextChangeEvent } from '../adapter';

type EventCallback = (type: string, body?: Record<string, unknown>) => void;
type TextCallback = (event: TextChangeEvent) => void;

interface TestAdapter {
  adapter: HostAdapter;
  setBuffer: (text: string) => void;
  emitEvent: (type: string, body?: Record<string, unknown>) => void;
  emitText: (text: string, source: 'user' | 'runtime') => void;
}

function makeAdapter(initial = ''): TestAdapter {
  let buffer = initial;
  const eventSubs: EventCallback[] = [];
  const textSubs: TextCallback[] = [];
  const adapter: Partial<HostAdapter> = {
    getText: () => buffer,
    onRender: () => () => undefined,
    onEvent: (cb) => { eventSubs.push(cb); return () => undefined; },
    onTextChange: (cb) => { textSubs.push(cb); return () => undefined; },
  };
  return {
    adapter: adapter as HostAdapter,
    setBuffer: (t) => { buffer = t; },
    emitEvent: (type, body) => { for (const cb of eventSubs) cb(type, body); },
    emitText: (text, source) => {
      buffer = text;
      for (const cb of textSubs) cb({ text, cursor: text.length, source, previousText: '' });
    },
  };
}

const ctx = (text: string): RenderContext => ({ text, cursor: 0, externalHighlights: [] });

describe('MarkdownRender — cache lifecycle', () => {
  let test: TestAdapter;
  let mr: MarkdownRender;
  beforeEach(() => {
    test = makeAdapter();
    mr = new MarkdownRender(test.adapter);
    mr.subscribe();
  });

  it('returns null before any LLM-substitution event has fired', () => {
    test.setBuffer('**hello** world');
    const r = mr.compute(ctx('**hello** world'));
    expect(r).toBe(null);
  });

  it('caches ranges after a blank.substituted event and emits them on render', () => {
    test.setBuffer('**hello** world');
    test.emitEvent('blank.substituted', { blankName: 'demo' });
    const r = mr.compute(ctx('**hello** world'));
    expect(r).not.toBeNull();
    expect(r!.boldRanges).toEqual([{ start: 0, end: 9 }]);
  });

  it('re-parses after a transform-blank.completed event', () => {
    test.setBuffer('# Heading\n*italic* text');
    test.emitEvent('transform-blank.completed', {});
    const r = mr.compute(ctx('# Heading\n*italic* text'));
    expect(r!.headingRanges?.length).toBe(1);
    expect(r!.italicRanges?.length).toBe(1);
  });

  it('re-parses after an agent-rewrite.round-completed event', () => {
    test.setBuffer('`code` and **bold**');
    test.emitEvent('agent-rewrite.round-completed', {});
    const r = mr.compute(ctx('`code` and **bold**'));
    expect(r!.codeRanges?.length).toBe(1);
    expect(r!.boldRanges?.length).toBe(1);
  });

  it('ignores events not in the trigger list', () => {
    test.setBuffer('**hello**');
    test.emitEvent('cursor.changed', {});
    expect(mr.compute(ctx('**hello**'))).toBeNull();
  });

  it('user typing invalidates the cache; compute returns null until next substitution', () => {
    test.setBuffer('**hello** world');
    test.emitEvent('blank.substituted', {});
    expect(mr.compute(ctx('**hello** world'))).not.toBeNull();
    // User types — buffer changes.
    test.emitText('**hello** world!', 'user');
    expect(mr.compute(ctx('**hello** world!'))).toBeNull();
  });

  it('runtime-source text changes do NOT invalidate the cache', () => {
    test.setBuffer('**hello**');
    test.emitEvent('blank.substituted', {});
    expect(mr.compute(ctx('**hello**'))).not.toBeNull();
    // Runtime write (e.g. cycling, ZWS toggle) — must not clear cache.
    test.emitText('**hello**', 'runtime');
    const r = mr.compute(ctx('**hello**'));
    expect(r).not.toBeNull();
    expect(r!.boldRanges?.length).toBe(1);
  });

  it('cache invalidates silently when the ctx text drifts from the parsed text', () => {
    test.setBuffer('**hello**');
    test.emitEvent('blank.substituted', {});
    // Now compute against a DIFFERENT text — host moved on without firing events.
    const r = mr.compute(ctx('plain text now'));
    expect(r).toBeNull();
  });

  it('back-to-back substitutions: latest LLM rewrite wins, cache is refreshed', () => {
    test.setBuffer('**first**');
    test.emitEvent('blank.substituted', {});
    let r = mr.compute(ctx('**first**'));
    expect(r!.boldRanges).toEqual([{ start: 0, end: 9 }]);
    // Another substitution lands.
    test.setBuffer('# Heading');
    test.emitEvent('blank.substituted', {});
    r = mr.compute(ctx('# Heading'));
    expect(r!.headingRanges?.length).toBe(1);
    expect(r!.boldRanges?.length ?? 0).toBe(0);
  });
});

describe('MarkdownRender — output directive shape', () => {
  let test: TestAdapter;
  let mr: MarkdownRender;
  beforeEach(() => {
    test = makeAdapter();
    mr = new MarkdownRender(test.adapter);
    mr.subscribe();
  });

  it('emits all 6 range types when present', () => {
    const text = '# Title\n**bold** *italic* `code` ~~strike~~\n- bullet';
    test.setBuffer(text);
    test.emitEvent('blank.substituted', {});
    const r = mr.compute(ctx(text));
    expect(r!.headingRanges?.length).toBe(1);
    expect(r!.boldRanges?.length).toBe(1);
    expect(r!.italicRanges?.length).toBe(1);
    expect(r!.codeRanges?.length).toBe(1);
    expect(r!.strikeRanges?.length).toBe(1);
    expect(r!.listRanges?.length).toBe(1);
  });

  it('plain prose: every range list is empty (or omitted) — null is also fine', () => {
    test.setBuffer('Hello plain world.');
    test.emitEvent('blank.substituted', {});
    const r = mr.compute(ctx('Hello plain world.'));
    // Non-null but every range list empty.
    expect(r).not.toBeNull();
    const total = (r!.boldRanges?.length ?? 0)
      + (r!.italicRanges?.length ?? 0)
      + (r!.codeRanges?.length ?? 0)
      + (r!.strikeRanges?.length ?? 0)
      + (r!.headingRanges?.length ?? 0)
      + (r!.listRanges?.length ?? 0);
    expect(total).toBe(0);
  });
});

describe('MarkdownRender — forceReparse (test-only)', () => {
  it('forceReparse re-runs the parse against current adapter text', () => {
    const test = makeAdapter('# initial');
    const mr = new MarkdownRender(test.adapter);
    mr.forceReparse();
    expect(mr.compute(ctx('# initial'))?.headingRanges?.length).toBe(1);
    test.setBuffer('plain');
    mr.forceReparse();
    expect(mr.compute(ctx('plain'))?.headingRanges?.length ?? 0).toBe(0);
  });
});
