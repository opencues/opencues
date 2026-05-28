// "Span-as-unit" indication tests — pins the contract for blanks
// flagged `blankClearOnEdit: true` (the opencues-settings + claude-status
// shipped defaults are the canonical examples).
//
// Why this exists: when a blank substitutes a multi-word answer that
// behaves as a single editable unit, a user's first backspace deletes
// the entire span — not one character. Without a visible indication,
// the keystroke "wipes 20 chars at once" looks like a bug.
//
// Contract surfaced via module events that hosts can subscribe to:
//   - `blank.substituted` { spanAsUnit: true }    on landing
//   - `blank.span-wiped`  { reason, wipedCharCount } on wipe
//
// Chrome bootstrap subscribes to both and emits console lines — that's
// the user-visible indication.

import { describe, it, expect } from 'vitest';
import { BlankFill } from './blank-fill';
import { ConfigLoader } from './config-loader';
import { MockAdapter, wrapTipsAsCuesMd } from '../../testing/mock-adapter';
import { SpanFillState } from '../state/span-fill';
import type { KeyEvent } from '../adapter';

function makeUnderscoreEvent(text: string, cursor: number): KeyEvent {
  return {
    key: '_',
    modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    text,
    cursorOffset: cursor,
  };
}

const TIPS = wrapTipsAsCuesMd({ concepts: [] });

// stepValues so the blank substitutes synchronously without an LLM call
// — we're testing the wipe contract, not LLM resolution. Three lines so
// the resulting span has multiple alternatives + spans multiple words.
const CLEAR_ON_EDIT_BLANK = `---
type: blank
name: my-multi
blankKeywords: setup, configure
blankProximity: 0
blankClearKeywords: true
blankClearOnEdit: true
stepValues: ["first long answer", "second long answer", "third long answer"]
---
`;

async function setupFill() {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: {
      '/mock/CUES.md': TIPS,
      '/proj/blanks/my-multi/BLANK.md': CLEAR_ON_EDIT_BLANK,
    },
  });
  const loader = new ConfigLoader(adapter);
  await loader.load();
  const spanFill = new SpanFillState();
  const bf = new BlankFill(adapter, loader, spanFill);
  bf.subscribe();
  return { adapter, loader, bf, spanFill };
}

describe('blankClearOnEdit — span-as-unit indication + wipe behaviour', () => {
  it('emits blank.substituted with spanAsUnit: true when a clearOnEdit blank lands', async () => {
    const { adapter, bf, spanFill } = await setupFill();

    // Type the trigger: keyword + space + `_`. Returns one substituted
    // multi-word answer; blankClearKeywords: true means the keyword
    // itself is dropped.
    adapter.pushText('setup ');
    bf.onUnderscoreKey(makeUnderscoreEvent('setup ', 6));

    // The substitution should have landed AND the span should be live.
    expect(spanFill.current).not.toBeNull();
    expect(spanFill.current?.clearOnEdit).toBe(true);
    expect(spanFill.current?.spanLength).toBeGreaterThan(1); // multi-word

    // Event surface: hosts learn this is span-as-unit via spanAsUnit.
    const substituted = adapter.events.find(e => e.type === 'blank.substituted');
    expect(substituted).toBeDefined();
    expect((substituted!.body as { spanAsUnit?: boolean }).spanAsUnit).toBe(true);
  });

  it('one keystroke INSIDE the span wipes the whole span AND emits blank.span-wiped', async () => {
    const { adapter, bf, spanFill } = await setupFill();
    adapter.pushText('setup ');
    bf.onUnderscoreKey(makeUnderscoreEvent('setup ', 6));

    expect(spanFill.current).not.toBeNull();
    const filledText = adapter.getText(); // e.g. "first long answer"
    expect(filledText).toContain('first long answer');

    // Clear the events from the substitution step so we only assert on
    // what the wipe path emits.
    const eventCountBeforeWipe = adapter.events.length;

    // Simulate a user keystroke INSIDE the span — single-character
    // mutation in the middle of the buffer. The pushText carries
    // source='runtime' from the mock by default, so spoof a user-source
    // text-change manually by mutating + dispatching.
    const mutated = filledText.slice(0, 3) + 'X' + filledText.slice(3);
    adapter.pushText(mutated); // triggers the onTextChange listener

    // Expectations:
    //   1. spanFill cleared (the contract).
    //   2. The whole substituted region is GONE from the buffer (not
    //      just the keystroke-mutated bit).
    //   3. A blank.span-wiped event was emitted carrying the wipe size.
    expect(spanFill.current).toBeNull();
    expect(adapter.getText()).not.toContain('first long answer');

    const wiped = adapter.events.slice(eventCountBeforeWipe).find(e => e.type === 'blank.span-wiped');
    expect(wiped).toBeDefined();
    expect((wiped!.body as { reason?: string }).reason).toBe('edit-inside-span');
    expect((wiped!.body as { wipedCharCount?: number }).wipedCharCount).toBeGreaterThan(0);
  });

  it('an edit OUTSIDE the span preserves the span — no wipe event', async () => {
    const { adapter, bf, spanFill } = await setupFill();
    adapter.pushText('setup ');
    bf.onUnderscoreKey(makeUnderscoreEvent('setup ', 6));
    expect(spanFill.current).not.toBeNull();

    const eventCountBeforeEdit = adapter.events.length;
    const filledText = adapter.getText();

    // Append text AFTER the span — should re-anchor positions but
    // keep the span alive.
    adapter.pushText(filledText + ' some unrelated extra typing');

    expect(spanFill.current).not.toBeNull(); // span survived
    expect(adapter.getText()).toContain('first long answer'); // span content intact

    const wiped = adapter.events.slice(eventCountBeforeEdit).find(e => e.type === 'blank.span-wiped');
    expect(wiped).toBeUndefined();
  });

  it('non-clearOnEdit blanks do NOT advertise spanAsUnit', async () => {
    // Same shape but without blankClearOnEdit — control case so the
    // indication only fires for the right blanks.
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/mock/CUES.md': TIPS,
        '/proj/blanks/plain/BLANK.md': `---
type: blank
name: plain
blankKeywords: list
blankProximity: 0
stepValues: ["one two three", "four five six"]
---
`,
      },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const spanFill = new SpanFillState();
    const bf = new BlankFill(adapter, loader, spanFill);
    bf.subscribe();

    adapter.pushText('list ');
    bf.onUnderscoreKey(makeUnderscoreEvent('list ', 5));

    const substituted = adapter.events.find(e => e.type === 'blank.substituted');
    expect(substituted).toBeDefined();
    expect((substituted!.body as { spanAsUnit?: boolean }).spanAsUnit).toBe(false);
  });
});
