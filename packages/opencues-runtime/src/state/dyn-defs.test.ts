import { describe, expect, it } from 'vitest';
import { DynDefs, reconstructAsTyped, reconstructAsTypedWithMap } from './dyn-defs';
import { splitWords } from '../modules/navigation';

describe('reconstructAsTyped', () => {
  // Builds the "as the user typed it" view by reverting each
  // agent-edited word to its originalWord. Used by transform-blank
  // EXTRACT to detect TASK_* triggers against what the user typed,
  // not what the agent rendered.

  it('returns visible verbatim when there are no defs', () => {
    const dynDefs = new DynDefs();
    expect(reconstructAsTyped('agentically translate _', dynDefs, splitWords))
      .toBe('agentically translate _');
  });

  it('returns visible verbatim when defs exist but currentIndex is 0', () => {
    // currentIndex=0 means the user is on the original word — agent
    // hasn't substituted. Nothing to revert.
    const dynDefs = new DynDefs();
    dynDefs.set(0, {
      originalWord: 'rite', alternatives: ['rite', 'write'], currentIndex: 0,
      spanStart: 0, spanEnd: 4,
    });
    expect(reconstructAsTyped('rite stuff', dynDefs, splitWords))
      .toBe('rite stuff');
  });

  it('reverts a single-word edit to its originalWord', () => {
    // Buffer shows "write stuff" but the user actually typed "rite".
    // Reconstruction should give "rite stuff".
    const dynDefs = new DynDefs();
    dynDefs.set(0, {
      originalWord: 'rite', alternatives: ['rite', 'write'], currentIndex: 1,
      spanStart: 0, spanEnd: 5, blankName: 'agent-task',
    });
    expect(reconstructAsTyped('write stuff', dynDefs, splitWords))
      .toBe('rite stuff');
  });

  it('reverts a multi-word agent edit back to its single originalWord', () => {
    // Visible: "I ich werde go" — agent translated "will" → "ich werde".
    // As-typed: "I will go".
    const dynDefs = new DynDefs();
    dynDefs.set(1, {
      originalWord: 'will', alternatives: ['will', 'ich werde'], currentIndex: 1,
      spanStart: 2, spanEnd: 11, blankName: 'agent-task',
    });
    expect(reconstructAsTyped('I ich werde go', dynDefs, splitWords))
      .toBe('I will go');
  });

  it('the trigger keyword survives an agent translation in the visible buffer', () => {
    // Visible: "agentisch translate to german _" — agent translated
    // "agentically" → "agentisch". As-typed: the user's original.
    const dynDefs = new DynDefs();
    dynDefs.set(0, {
      originalWord: 'agentically', alternatives: ['agentically', 'agentisch'], currentIndex: 1,
      spanStart: 0, spanEnd: 9, blankName: 'agent-task',
    });
    const visible = 'agentisch translate to german _';
    const reconstructed = reconstructAsTyped(visible, dynDefs, splitWords);
    expect(reconstructed).toBe('agentically translate to german _');
    // Trigger detection in the as-typed view succeeds:
    expect(reconstructed.includes('agentically')).toBe(true);
  });

  it('preserves whitespace including newlines and tabs', () => {
    const dynDefs = new DynDefs();
    dynDefs.set(0, {
      originalWord: 'agentically', alternatives: ['agentically', 'foo'], currentIndex: 1,
      spanStart: 0, spanEnd: 3, blankName: 'agent-task',
    });
    const visible = 'foo\n\ntranslate\tto german _';
    expect(reconstructAsTyped(visible, dynDefs, splitWords))
      .toBe('agentically\n\ntranslate\tto german _');
  });

  it('handles multiple agent edits in one buffer', () => {
    const dynDefs = new DynDefs();
    dynDefs.set(0, {
      originalWord: 'rite', alternatives: ['rite', 'write'], currentIndex: 1,
      spanStart: 0, spanEnd: 5, blankName: 'agent-task',
    });
    dynDefs.set(2, {
      originalWord: 'witth', alternatives: ['witth', 'with'], currentIndex: 1,
      spanStart: 12, spanEnd: 16, blankName: 'agent-task',
    });
    const visible = 'write text with typos';
    expect(reconstructAsTyped(visible, dynDefs, splitWords))
      .toBe('rite text witth typos');
  });
});

describe('reconstructAsTypedWithMap — char-by-char position mapping', () => {
  // The mapping is used by `trimTriggerFromText` to translate a trigger
  // keyword position from the as-typed view back to the visible
  // buffer's char range, so the trim can preserve agent edits that
  // sit between the trigger and the `_`.

  function findInVisible(visible: string, asTyped: string, map: readonly number[], asTypedSubstr: string): { visStart: number; visEnd: number } {
    const asStart = asTyped.toLowerCase().indexOf(asTypedSubstr.toLowerCase());
    if (asStart < 0) throw new Error(`substring "${asTypedSubstr}" not found in asTyped`);
    return { visStart: map[asStart], visEnd: map[asStart + asTypedSubstr.length - 1] };
  }

  it('maps every char between trigger keyword and `_` to its visible position when intervening words are agent-edited', () => {
    // Visible buffer: agent translated `prose` → `text` mid-sentence.
    // User typed: "agentically translate prose to german _"
    // Visible:    "agentically translate text to german _"
    //              ↑idx 0       ↑idx 1    ↑idx 2 (edited)
    const dynDefs = new DynDefs();
    dynDefs.set(2, {
      originalWord: 'prose', alternatives: ['prose', 'text'], currentIndex: 1,
      spanStart: 22, spanEnd: 26, blankName: 'agent-task',
    });
    const visible = 'agentically translate text to german _';
    const recon = reconstructAsTypedWithMap(visible, dynDefs, splitWords);

    expect(recon.asTyped).toBe('agentically translate prose to german _');

    // For every char from "agentically" through to `_` (inclusive),
    // the map must point to a visible char index that's:
    //  (a) within the visible buffer's bounds, and
    //  (b) IDENTITY-mapped for chars OUTSIDE the agent-edited word's
    //      asTyped range, and
    //  (c) within the agent-edited word's visible range for asTyped
    //      chars that fall on the edited word.
    expect(recon.asTypedToVisible.length).toBe(recon.asTyped.length);

    // The trigger keyword "agentically" is at asTyped 0..10. Visible
    // position should be 0..10 (identity — no edit before it).
    expect(recon.asTypedToVisible[0]).toBe(0);
    expect(recon.asTypedToVisible[10]).toBe(10);

    // Whitespace + "translate" + space — identity until the edited word.
    // "agentically " is 12 chars in BOTH asTyped and visible (no edit
    // before this point), so asTyped[12]='t' (start of "translate")
    // → visible[12]='t'.
    expect(recon.asTypedToVisible[12]).toBe(12);

    // The edited word "prose" sits at asTyped 22..26. In visible,
    // that range corresponds to "text" at 22..25. The map for any
    // char in "prose" must land inside [22, 26).
    for (let i = 22; i < 27; i += 1) {
      expect(recon.asTypedToVisible[i]).toBeGreaterThanOrEqual(22);
      expect(recon.asTypedToVisible[i]).toBeLessThan(26);
    }

    // After the edited word, the gap " to german _" — both buffers
    // have it identically AFTER their respective edit-word lengths.
    // asTyped offset of " to german _" tail = 27 (after "prose ").
    // visible offset of " to german _" tail = 26 (after "text ").
    // The mapping handles the offset shift transparently.
    const tailAsTyped = 'to german _';
    const tailLoc = findInVisible(visible, recon.asTyped, recon.asTypedToVisible, tailAsTyped);
    expect(visible.slice(tailLoc.visStart, tailLoc.visEnd + 1)).toBe(tailAsTyped);
  });

  it('locates trigger keyword AND the trailing `_` in visible when both sit BEFORE and AFTER an edited word', () => {
    // The user-relevant invariant: for any trigger phrase + `_`, the
    // asTyped→visible mapping at trigger-keyword start AND at the `_`
    // must point to the right visible chars so the trim can splice
    // out exactly that range.
    const dynDefs = new DynDefs();
    // Agent edited "translate" → "übersetzen" mid-trigger-prose.
    dynDefs.set(1, {
      originalWord: 'translate', alternatives: ['translate', 'übersetzen'], currentIndex: 1,
      spanStart: 12, spanEnd: 22, blankName: 'agent-task',
    });
    const visible = 'agentically übersetzen to german _';
    const recon = reconstructAsTypedWithMap(visible, dynDefs, splitWords);

    expect(recon.asTyped).toBe('agentically translate to german _');

    // Trigger keyword `agentically` at asTyped 0 → visible 0.
    const kwAsTypedIdx = recon.asTyped.toLowerCase().indexOf('agentically');
    expect(recon.asTypedToVisible[kwAsTypedIdx]).toBe(0);

    // `_` at asTyped → corresponding visible position.
    const blankAsTypedIdx = recon.asTyped.indexOf('_');
    const blankVisibleIdx = recon.asTypedToVisible[blankAsTypedIdx];
    expect(visible.charAt(blankVisibleIdx)).toBe('_');
    expect(blankVisibleIdx).toBe(visible.indexOf('_'));
  });

  it('mapping is monotonically non-decreasing (positions never go backwards)', () => {
    // A correctness invariant: as you walk asTyped forward, the visible
    // position should not jump backwards. Any backwards jump would
    // mean trim could splice a malformed range.
    const dynDefs = new DynDefs();
    dynDefs.set(0, {
      originalWord: 'short', alternatives: ['short', 'somewhat-longer-word'], currentIndex: 1,
      spanStart: 0, spanEnd: 20, blankName: 'agent-task',
    });
    dynDefs.set(2, {
      originalWord: 'will', alternatives: ['will', 'ich werde'], currentIndex: 1,
      spanStart: 25, spanEnd: 34, blankName: 'agent-task',
    });
    const visible = 'somewhat-longer-word and ich werde do this _';
    const recon = reconstructAsTypedWithMap(visible, dynDefs, splitWords);

    for (let i = 1; i < recon.asTypedToVisible.length; i += 1) {
      expect(recon.asTypedToVisible[i]).toBeGreaterThanOrEqual(recon.asTypedToVisible[i - 1]);
    }
    // Final mapping points within visible bounds.
    expect(recon.asTypedToVisible[recon.asTypedToVisible.length - 1]).toBeLessThan(visible.length);
  });

  it('whitespace gap mappings are identity (chars between words map directly)', () => {
    const dynDefs = new DynDefs();
    dynDefs.set(0, {
      originalWord: 'agentically', alternatives: ['agentically', 'agentisch'], currentIndex: 1,
      spanStart: 0, spanEnd: 9, blankName: 'agent-task',
    });
    const visible = 'agentisch translate to german _';
    const recon = reconstructAsTypedWithMap(visible, dynDefs, splitWords);

    // The space after the trigger keyword: in asTyped it's at idx 11
    // ("agentically" = 11 chars). In visible "agentisch" = 9 chars,
    // so the corresponding space is at visible idx 9. The mapping
    // for asTyped char 11 should be visible 9.
    expect(recon.asTyped.charAt(11)).toBe(' ');
    expect(recon.asTypedToVisible[11]).toBe(9);

    // Every char in "translate to german _" — both buffers have the
    // SAME chars in identical order after the (different-length)
    // first word. Mapping must identity-walk after the edit.
    const tail = 'translate to german _';
    const asTypedTailStart = recon.asTyped.indexOf(tail);
    const visibleTailStart = visible.indexOf(tail);
    for (let j = 0; j < tail.length; j += 1) {
      expect(recon.asTypedToVisible[asTypedTailStart + j]).toBe(visibleTailStart + j);
    }
  });
});
