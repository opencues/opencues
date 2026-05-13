// Tests for MarkdownRender — receives `markdown.styled` events, caches
// per-style ranges, emits them as RenderDirectives. The strip happens
// upstream (markdown-substitute.ts); MarkdownRender is purely a
// directive-emitter.

import { describe, expect, it, beforeEach } from 'vitest';
import { MarkdownRender } from './markdown-render';
import type { HostAdapter, RenderContext, TextChangeEvent } from '../adapter';

type EventCallback = (type: string, body?: Record<string, unknown>) => void;
type TextCallback = (event: TextChangeEvent) => void;

interface TestAdapter {
  adapter: HostAdapter;
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
    emitEvent: (type, body) => { for (const cb of eventSubs) cb(type, body); },
    emitText: (text, source) => {
      buffer = text;
      for (const cb of textSubs) cb({ text, cursor: text.length, source, previousText: '' });
    },
  };
}

const ctx = (text: string): RenderContext => ({ text, cursor: 0, externalHighlights: [] });

describe('MarkdownRender — cache from event', () => {
  let test: TestAdapter;
  let mr: MarkdownRender;
  beforeEach(() => {
    test = makeAdapter();
    mr = new MarkdownRender(test.adapter);
    mr.subscribe();
  });

  it('returns null before any markdown.styled event arrives', () => {
    expect(mr.compute(ctx('hello'))).toBeNull();
  });

  it('caches payload from markdown.styled and emits ranges on render', () => {
    test.emitEvent('markdown.styled', {
      text: 'bold here',
      bold: [{ start: 0, end: 4 }],
      italic: [], code: [], strike: [], heading: [], list: [],
    });
    const r = mr.compute(ctx('bold here'));
    expect(r).not.toBeNull();
    expect(r!.boldRanges).toEqual([{ start: 0, end: 4 }]);
  });

  it('ignores events of other types', () => {
    test.emitEvent('cursor.changed', { text: 'hi', bold: [] });
    expect(mr.compute(ctx('hi'))).toBeNull();
  });

  it('drops cache when ctx text drifts from cached text', () => {
    test.emitEvent('markdown.styled', {
      text: 'bold here',
      bold: [{ start: 0, end: 4 }],
      italic: [], code: [], strike: [], heading: [], list: [],
    });
    expect(mr.compute(ctx('something else'))).toBeNull();
  });

  it('user appending text after the styled prefix keeps the cache', () => {
    // Cache should SURVIVE user typing that EXTENDS the styled prefix —
    // the existing ranges are still valid at their original offsets.
    // Only mutating the styled prefix itself drops the cache (next test).
    test.emitEvent('markdown.styled', {
      text: 'bold here',
      bold: [{ start: 0, end: 4 }],
      italic: [], code: [], strike: [], heading: [], list: [],
    });
    expect(mr.compute(ctx('bold here'))).not.toBeNull();
    test.emitText('bold here!', 'user');
    // Visible now extends with `!` — bold range still applies at [0,4].
    const r = mr.compute(ctx('bold here!'));
    expect(r).not.toBeNull();
    expect(r!.boldRanges).toEqual([{ start: 0, end: 4 }]);
  });

  it('user mutating the styled prefix invalidates the cache', () => {
    test.emitEvent('markdown.styled', {
      text: 'bold here',
      bold: [{ start: 0, end: 4 }],
      italic: [], code: [], strike: [], heading: [], list: [],
    });
    expect(mr.compute(ctx('bold here'))).not.toBeNull();
    test.emitText('BOLD here', 'user');
    expect(mr.compute(ctx('BOLD here'))).toBeNull();
  });

  it('runtime-source text changes do NOT invalidate', () => {
    test.emitEvent('markdown.styled', {
      text: 'bold here',
      bold: [{ start: 0, end: 4 }],
      italic: [], code: [], strike: [], heading: [], list: [],
    });
    test.emitText('bold here', 'runtime');   // same text, runtime source
    const r = mr.compute(ctx('bold here'));
    expect(r).not.toBeNull();
    expect(r!.boldRanges).toEqual([{ start: 0, end: 4 }]);
  });

  it('emits all 6 range types when present in payload', () => {
    test.emitEvent('markdown.styled', {
      text: 'Title\nfoo bar baz\none\ntwo',
      bold: [{ start: 6, end: 9 }],
      italic: [{ start: 10, end: 13 }],
      code: [{ start: 14, end: 17 }],
      strike: [],
      heading: [{ start: 0, end: 5 }],
      list: [{ start: 18, end: 21 }, { start: 22, end: 25 }],
    });
    const r = mr.compute(ctx('Title\nfoo bar baz\none\ntwo'));
    expect(r!.boldRanges?.length).toBe(1);
    expect(r!.italicRanges?.length).toBe(1);
    expect(r!.codeRanges?.length).toBe(1);
    expect(r!.headingRanges?.length).toBe(1);
    expect(r!.listRanges?.length).toBe(2);
  });

  it('back-to-back substitutions: latest payload wins', () => {
    test.emitEvent('markdown.styled', {
      text: 'first',
      bold: [{ start: 0, end: 5 }],
      italic: [], code: [], strike: [], heading: [], list: [],
    });
    expect(mr.compute(ctx('first'))!.boldRanges).toEqual([{ start: 0, end: 5 }]);
    test.emitEvent('markdown.styled', {
      text: 'second word',
      bold: [],
      italic: [{ start: 7, end: 11 }],
      code: [], strike: [], heading: [], list: [],
    });
    const r = mr.compute(ctx('second word'));
    expect(r!.italicRanges).toEqual([{ start: 7, end: 11 }]);
    expect(r!.boldRanges).toEqual([]);
  });

  it('malformed event (missing text field) is ignored', () => {
    test.emitEvent('markdown.styled', { bold: [{ start: 0, end: 4 }] });   // no `text`
    expect(mr.compute(ctx('whatever'))).toBeNull();
  });
});
