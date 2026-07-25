import { describe, expect, it } from 'vitest';
import { applyMarkdownAwareSubstitution } from './markdown-substitute';
import type { HostAdapter } from '../adapter';

type EventEntry = { type: string; body?: Record<string, unknown> };

interface TestAdapter {
  adapter: HostAdapter;
  getBuffer: () => string;
  getCursor: () => number;
  events: EventEntry[];
  setTextCalls: string[];
  pushTextCalls: Array<{ text: string; cursor?: number }>;
}

function makeAdapter(initial = ''): TestAdapter {
  let buffer = initial;
  let cursor = 0;
  const events: EventEntry[] = [];
  const setTextCalls: string[] = [];
  const pushTextCalls: Array<{ text: string; cursor?: number }> = [];
  const adapter: Partial<HostAdapter> = {
    getText: () => buffer,
    getCursorOffset: () => cursor,
    setText: (s: string) => { buffer = s; setTextCalls.push(s); },
    setCursorOffset: (n: number) => { cursor = n; },
    forceRender: () => undefined,
    pushText: (s: string, c?: number) => {
      buffer = s;
      if (c !== undefined) cursor = c;
      pushTextCalls.push({ text: s, cursor: c });
    },
    emitEvent: (type, body) => { events.push({ type, body }); },
  };
  return {
    adapter: adapter as HostAdapter,
    getBuffer: () => buffer,
    getCursor: () => cursor,
    events, setTextCalls, pushTextCalls,
  };
}

describe('markdown pass-through (adapter.markdownPassthrough)', () => {
  function passthroughAdapter(initial = '') {
    const t = makeAdapter(initial);
    (t.adapter as { markdownPassthrough?: () => boolean }).markdownPassthrough = () => true;
    return t;
  }

  it('writes markers VERBATIM and fires no markdown.styled event', () => {
    const t = passthroughAdapter();
    const r = applyMarkdownAwareSubstitution(t.adapter, 'hello **world**');
    expect(t.getBuffer()).toBe('hello **world**');
    expect(r.hadMarkdown).toBe(false);
    expect(t.events.filter(e => e.type === 'markdown.styled')).toHaveLength(0);
  });

  it('cursor lands at end of the RAW (unstripped) insertion', () => {
    const t = passthroughAdapter();
    const r = applyMarkdownAwareSubstitution(t.adapter, '**bold**');
    expect(r.newCursor).toBe('**bold**'.length);
  });

  it('hook returning false keeps the strip path byte-identical', () => {
    const t = makeAdapter();
    (t.adapter as { markdownPassthrough?: () => boolean }).markdownPassthrough = () => false;
    const r = applyMarkdownAwareSubstitution(t.adapter, 'hello **world**');
    expect(t.getBuffer()).toBe('hello world');
    expect(r.hadMarkdown).toBe(true);
  });

  it('hook absent (every in-process host) keeps the strip path', () => {
    const t = makeAdapter();
    const r = applyMarkdownAwareSubstitution(t.adapter, 'hello **world**');
    expect(t.getBuffer()).toBe('hello world');
    expect(r.hadMarkdown).toBe(true);
  });
});

describe('applyMarkdownAwareSubstitution — buffer write', () => {
  it('strips markers from rewriteText and writes the stripped form', () => {
    const t = makeAdapter();
    const r = applyMarkdownAwareSubstitution(t.adapter, 'hello **world**');
    expect(r.stripped).toBe('hello world');
    expect(t.getBuffer()).toBe('hello world');
    expect(r.hadMarkdown).toBe(true);
  });

  it('prefers pushText when the adapter supports it', () => {
    const t = makeAdapter();
    applyMarkdownAwareSubstitution(t.adapter, '**bold**');
    expect(t.pushTextCalls.length).toBe(1);
    expect(t.setTextCalls.length).toBe(0);
  });

  it('falls back to setText + forceRender when pushText is missing', () => {
    const t = makeAdapter();
    delete (t.adapter as { pushText?: unknown }).pushText;
    applyMarkdownAwareSubstitution(t.adapter, '**bold**');
    expect(t.setTextCalls.length).toBe(1);
    expect(t.setTextCalls[0]).toBe('bold');
  });

  it('applies the cursor offset when supplied', () => {
    const t = makeAdapter();
    applyMarkdownAwareSubstitution(t.adapter, '**bold**', { cursor: 4 });
    expect(t.getCursor()).toBe(4);
  });
});

describe('applyMarkdownAwareSubstitution — event emission', () => {
  it('emits markdown.styled when markdown is present', () => {
    const t = makeAdapter();
    applyMarkdownAwareSubstitution(t.adapter, 'hello **world**');
    const styled = t.events.find(e => e.type === 'markdown.styled');
    expect(styled).toBeTruthy();
    expect(styled!.body!.text).toBe('hello world');
    expect(styled!.body!.bold).toEqual([{ start: 6, end: 11 }]);
  });

  it('does NOT emit markdown.styled for plain text', () => {
    const t = makeAdapter();
    applyMarkdownAwareSubstitution(t.adapter, 'plain rewrite');
    expect(t.events.find(e => e.type === 'markdown.styled')).toBeFalsy();
  });

  it('emits per-style ranges in stripped-text coords', () => {
    const t = makeAdapter();
    applyMarkdownAwareSubstitution(t.adapter, '# Title\n**bold** *italic* `code`');
    const styled = t.events.find(e => e.type === 'markdown.styled')!;
    expect(styled.body!.text).toBe('Title\nbold italic code');
    expect(styled.body!.heading).toEqual([{ start: 0, end: 5 }]);
    expect(styled.body!.bold).toEqual([{ start: 6, end: 10 }]);
    expect(styled.body!.italic).toEqual([{ start: 11, end: 17 }]);
    expect(styled.body!.code).toEqual([{ start: 18, end: 22 }]);
  });
});

describe('applyMarkdownAwareSubstitution — suppress ranges', () => {
  it('honours suppressRanges (keeps markers literal across blank slots)', () => {
    const t = makeAdapter();
    // Active slot at offset 8 (`_`). Bold pair wraps it → keep markers.
    const r = applyMarkdownAwareSubstitution(t.adapter, '**hello _ world**', {
      suppressRanges: [{ start: 8, end: 9 }],
    });
    expect(r.stripped).toBe('**hello _ world**');
    expect(r.hadMarkdown).toBe(false);
    expect(t.events.find(e => e.type === 'markdown.styled')).toBeFalsy();
  });

  it('strips markdown outside suppress regions', () => {
    const t = makeAdapter();
    const r = applyMarkdownAwareSubstitution(t.adapter, '**bold** then _ blank', {
      suppressRanges: [{ start: 14, end: 15 }],
    });
    expect(r.stripped).toBe('bold then _ blank');
    expect(r.payload.bold).toEqual([{ start: 0, end: 4 }]);
  });
});

describe('applyMarkdownAwareSubstitution — return value', () => {
  it('returns the stripped string + hadMarkdown + payload', () => {
    const t = makeAdapter();
    const r = applyMarkdownAwareSubstitution(t.adapter, '**bold**');
    expect(r.stripped).toBe('bold');
    expect(r.hadMarkdown).toBe(true);
    expect(r.payload.text).toBe('bold');
    expect(r.payload.bold).toEqual([{ start: 0, end: 4 }]);
  });

  it('hadMarkdown=false for plain text', () => {
    const t = makeAdapter();
    const r = applyMarkdownAwareSubstitution(t.adapter, 'plain text');
    expect(r.hadMarkdown).toBe(false);
    expect(r.stripped).toBe('plain text');
  });
});
