import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Cycling } from './cycling';
import { ConfigLoader } from './config-loader';
import { Navigation } from './navigation';
import { BlankFill } from './blank-fill';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SpanFillState } from '../state/span-fill';
import { DismissedBlanks } from '../state/dismissed-blanks';
import { SelectorSatelliteState } from '../state/selector-satellite';
import { MockAdapter } from '../../testing/mock-adapter';

// Tips live inside CUES.md's `## Tips` JSON block — no separate file.
// Wrap a tips-data object as a minimal CUES.md so ConfigLoader's
// existing parser flow (parseCuesMd → cuesConfig.tips → cueMap) loads
// it just like a real config.
function wrapTipsAsCuesMd(tipsData: unknown): string {
  return `# tips fixture\n\n## Tips\n\`\`\`json\n${JSON.stringify(tipsData)}\n\`\`\`\n`;
}

const TIPS = wrapTipsAsCuesMd({
  domain: 'test',
  version: 1,
  concepts: [
    {
      id: 'words',
      words: {
        fast: { tip: '', alts: ['quick', 'rapid', 'swift'] },
        big: { tip: '', alts: ['large', 'huge'] },
      },
    },
  ],
});

async function setup(text: string) {
  const adapter = new MockAdapter({ files: { '/mock/CUES.md': TIPS } });
  adapter.pushText(text);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
  await loader.load();
  const cycling = new Cycling(adapter, hlState, dynDefs, loader);
  cycling.subscribe();
  const nav = new Navigation(adapter, hlState, dynDefs, loader);
  nav.subscribe();
  return { adapter, hlState, dynDefs, loader, cycling, nav };
}

describe('Cycling', () => {
  it('does nothing when highlight inactive', async () => {
    const { adapter } = await setup('fast slow');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
    expect(adapter.setTextCalls).toEqual([]);
  });

  it('GET arms the knob: Ctrl+Alt+Up adjusts a blankStep value at the caret with NO active highlight', async () => {
    // A filled volume value is a live knob. With the caret inside it and NO
    // navigation highlight, Ctrl+Alt+↑ still steps it (+blankStep, clamped) and
    // writes back via the script — the "GET arms the knob" contract. Confined to
    // blankStep actuators; plain cues still need an explicit navigate.
    const VOLUME_BLANK = `---
name: volume
type: blank
blankKeywords: volume
tip: system volume
icon: 🔊
blankStep: 6
blankSuffix: %
blankScript: ./vol.sh
---`;
    const adapter = new MockAdapter({ cwd: '/proj', files: { '/proj/blanks/volume/BLANK.md': VOLUME_BLANK } });
    adapter.pushText('volume 32%');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader);
    cycling.subscribe();
    // The fill registered a def at the value word (index 1 = "32%", chars [7,10)).
    dynDefs.set(1, { originalWord: '32%', alternatives: ['32%'], currentIndex: 0, spanStart: 7, spanEnd: 10, blankName: 'volume' });
    adapter.setCursorOffset(8);            // caret inside "32%"
    expect(hlState.active).toBe(false);    // NOT navigated — GET only
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('volume 38%');   // 32 + 6
    // And the def tracked the new value so a second step continues (and the note stays live).
    expect(dynDefs.get(1)?.alternatives).toEqual(['38%']);
  });

  it('Ctrl+Alt+Up replaces highlighted word with first alternative', async () => {
    const { adapter, hlState, dynDefs } = await setup('fast slow');
    hlState.activate(0, 'fast slow'); // fast
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('quick slow');
    const def = dynDefs.get(0);
    expect(def?.currentIndex).toBe(1); // alt 0 is original "fast", alt 1 is first cycle
    expect(def?.spanEnd).toBe(5); // "quick" is 5 chars
  });

  it('successive Up cycles through all alternatives and wraps', async () => {
    const { adapter, hlState } = await setup('fast');
    hlState.activate(0, 'fast');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → quick
    adapter.fireKey('up', { ctrl: true, alt: true }); // → rapid
    adapter.fireKey('up', { ctrl: true, alt: true }); // → swift
    adapter.fireKey('up', { ctrl: true, alt: true }); // → fast (wrap)
    expect(adapter.setTextCalls).toEqual(['quick', 'rapid', 'swift', 'fast']);
  });

  it('Ctrl+Alt+Down goes the other direction', async () => {
    const { adapter, hlState } = await setup('fast');
    hlState.activate(0, 'fast');
    adapter.fireKey('down', { ctrl: true, alt: true }); // → swift (last)
    expect(adapter.setTextCalls.at(-1)).toBe('swift');
  });

  it('returns false when word has no alternatives in cue map', async () => {
    const { adapter, hlState } = await setup('xyz unknown');
    hlState.activate(0, 'xyz unknown');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
  });

  it('cursor adjustment: cursor before word stays put', async () => {
    const { adapter, hlState } = await setup('fast slow');
    adapter.setCursorOffset(0);
    hlState.activate(0, 'fast slow');
    adapter.fireKey('up', { ctrl: true, alt: true }); // fast → quick (+1 char)
    expect(adapter.setCursorCalls.at(-1)).toBe(0); // cursor at 0 unchanged
  });

  it('cursor adjustment: cursor after word shifts by lenDiff', async () => {
    const { adapter, hlState } = await setup('fast slow');
    adapter.setCursorOffset(8); // after "fast slow"[start of slow + 'slo'] - past 'fast'
    hlState.activate(0, 'fast slow');
    adapter.fireKey('up', { ctrl: true, alt: true }); // fast (4) → quick (5), +1
    expect(adapter.setCursorCalls.at(-1)).toBe(9);
  });

  it('forceRender called after cycle', async () => {
    const { adapter, hlState } = await setup('fast');
    hlState.activate(0, 'fast');
    expect(adapter.forceRenderCalls).toBe(0);
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.forceRenderCalls).toBe(1);
  });

  it('Navigation + Cycling: Ctrl+Alt+Left then Up cycles the active word', async () => {
    const { adapter, hlState } = await setup('big fast');
    adapter.fireKey('left', { ctrl: true, alt: true }); // activate rightmost: fast (idx 1)
    expect(hlState.wordIndex).toBe(1);
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('big quick');
  });

  describe('nav-keymap scalar — ctrl-shift fallback', () => {
    // Pins the macOS-Terminal.app fallback. The same scenario as the
    // canonical Ctrl+Alt cycle test, but with `nav-keymap: ctrl-shift`
    // active. Verifies that (a) ctrl-shift+arrow now drives nav +
    // cycling, and (b) ctrl-alt+arrow goes inert (the unmatched
    // handler returns false so the host's own default takes over).
    async function setupCtrlShift(text: string) {
      const ctx = await setup(text);
      // applyOpenCuesScalar is the canonical in-memory mutation
      // path — the same one selector-satellite cycling uses when the
      // user flips a setting at runtime. Tests get hot-reload semantics
      // for free.
      ctx.loader.applyOpenCuesScalar('nav-keymap', 'ctrl-shift');
      return ctx;
    }

    it('Ctrl+Shift+Up drives cycling when nav-keymap: ctrl-shift', async () => {
      const { adapter, hlState } = await setupCtrlShift('fast slow');
      hlState.activate(0, 'fast slow');
      expect(adapter.fireKey('up', { ctrl: true, shift: true })).toBe(true);
      expect(adapter.setTextCalls.at(-1)).toBe('quick slow');
    });

    it('Ctrl+Alt+Up is inert when nav-keymap: ctrl-shift', async () => {
      const { adapter, hlState } = await setupCtrlShift('fast slow');
      hlState.activate(0, 'fast slow');
      expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
      expect(adapter.setTextCalls).toEqual([]);
    });

    it('Ctrl+Shift+Left/Right drives navigation when nav-keymap: ctrl-shift', async () => {
      const { adapter, hlState } = await setupCtrlShift('big fast');
      expect(adapter.fireKey('left', { ctrl: true, shift: true })).toBe(true);
      expect(hlState.wordIndex).toBe(1); // rightmost: fast
      expect(adapter.fireKey('up', { ctrl: true, shift: true })).toBe(true);
      expect(adapter.setTextCalls.at(-1)).toBe('big quick');
    });
  });
});

describe('Cycling — zero-alternative + invalid-input hardening', () => {
  it('a cueMap entry with a literal EMPTY alts array does nothing (distinct from "unknown word")', async () => {
    // Different from "returns false when word has no alternatives in cue
    // map" (that word is absent from the map entirely). Here the word IS
    // present in the map but its `alts` array is empty — buildDefFrom's
    // `lookup.alternatives.length === 0` guard must catch this shape too.
    const TIPS_EMPTY_ALTS = wrapTipsAsCuesMd({
      domain: 'test',
      version: 1,
      concepts: [{ id: 'words', words: { solo: { tip: '', alts: [] } } }],
    });
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': TIPS_EMPTY_ALTS } });
    adapter.pushText('solo word');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader);
    cycling.subscribe();
    hlState.activate(0, 'solo word');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
    expect(adapter.setTextCalls).toEqual([]);
    expect(dynDefs.get(0)).toBeUndefined();
  });

  it('direction=0 passed directly to step() is an idempotent no-op cycle (defense-in-depth)', async () => {
    // step()'s public type is `1 | -1`, but nothing at runtime stops a
    // caller from passing another integer (JS has no type enforcement).
    // The modulo formula `((idx + direction) % len + len) % len` is
    // mathematically well-defined for ANY integer direction, so this
    // pins that a stray 0 doesn't crash and leaves the cycle where it
    // started (same alt re-applied).
    const { adapter, hlState, cycling } = await setup('fast');
    hlState.activate(0, 'fast');
    const event = { key: 'up', modifiers: { ctrl: true, alt: true, shift: false, meta: false }, text: 'fast', cursorOffset: 4 };
    const consumed = cycling.step(event, 0 as unknown as 1);
    expect(consumed).toBe(true);
    // Same alt re-applied — the buffer's visible content is unchanged.
    expect(adapter.setTextCalls.at(-1)).toBe('fast');
  });

  it('a single call with a HUGE direction magnitude lands on the same index as N sequential unit steps (modulo equivalence)', async () => {
    // "fast" has 4 total alternatives (original + quick/rapid/swift).
    // 7 sequential +1 steps from index 0 land on index 3 ("swift") —
    // verified by the existing wraparound test. A single call with
    // direction=7 must land on the exact same index via the modulo
    // formula, even though the public type only allows ±1.
    const { adapter: adapterSeq, hlState: hlSeq } = await setup('fast');
    hlSeq.activate(0, 'fast');
    for (let i = 0; i < 7; i++) adapterSeq.fireKey('up', { ctrl: true, alt: true });
    const sequentialResult = adapterSeq.setTextCalls.at(-1);
    expect(sequentialResult).toBe('swift');

    const { adapter, hlState, cycling } = await setup('fast');
    hlState.activate(0, 'fast');
    const event = { key: 'up', modifiers: { ctrl: true, alt: true, shift: false, meta: false }, text: 'fast', cursorOffset: 4 };
    const consumed = cycling.step(event, 7 as unknown as 1);
    expect(consumed).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe(sequentialResult);
  });

  it('a single call with a large NEGATIVE direction magnitude lands on the same index as N sequential Down steps', async () => {
    const { adapter: adapterSeq, hlState: hlSeq } = await setup('fast');
    hlSeq.activate(0, 'fast');
    for (let i = 0; i < 7; i++) adapterSeq.fireKey('down', { ctrl: true, alt: true });
    const sequentialResult = adapterSeq.setTextCalls.at(-1);

    const { adapter, hlState, cycling } = await setup('fast');
    hlState.activate(0, 'fast');
    const event = { key: 'down', modifiers: { ctrl: true, alt: true, shift: false, meta: false }, text: 'fast', cursorOffset: 4 };
    const consumed = cycling.step(event, -7 as unknown as 1);
    expect(consumed).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe(sequentialResult);
  });
});

describe('Cycling static-alt multi-word spans', () => {
  // Cue source returns an alt that contains a space (LLM legitimately
  // suggests "legal eagle" for "attorney", "Jeff Bezos" for "ceo", etc).
  // The runtime needs to register this as a span in SpanFillState so:
  //   - Navigation treats the N words as ONE stop (left/right skip inner)
  //   - DimRender highlights the whole group as a unit
  //   - Subsequent cycles go through cycleSpanFill (Path 0), keeping
  //     currentAltIndex + spanLength in sync
  const MW_TIPS = wrapTipsAsCuesMd({
    domain: 'test',
    version: 1,
    concepts: [
      {
        id: 'words',
        words: {
          attorney: { tip: '', alts: ['lawyer', 'legal eagle', 'defendant counsel'] },
          ceo: { tip: '', alts: ['Jeff Bezos', 'Elon Musk', 'Tim Cook'] },
        },
      },
    ],
  });

  async function setupMw(text: string) {
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': MW_TIPS } });
    adapter.pushText(text);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const spanFillState = new SpanFillState();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, spanFillState);
    cycling.subscribe();
    const nav = new Navigation(adapter, hlState, dynDefs, spanFillState);
    nav.subscribe();
    // BlankFill's onTextChange is where SpanFillState preservation runs.
    // Wire it up so typing-past-the-span tests exercise the real path.
    const bf = new BlankFill(adapter, loader, spanFillState);
    bf.subscribe();
    return { adapter, hlState, dynDefs, spanFillState, cycling, nav, bf };
  }

  it('cycling to a multi-word alt creates an implicit span via DynDefs', async () => {
    // After Apr 2026 (option B refactor) static-alt spans are tracked
    // implicitly by DynDefs — a span exists wherever a DynDef's
    // currentAlt has multiple words. SpanFillState stays untouched
    // (it's reserved for blank-fills, single-slot).
    const { adapter, hlState, dynDefs, spanFillState } = await setupMw('the attorney');
    hlState.activate(1, 'the attorney');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → lawyer (single)
    expect(dynDefs.findSpanContaining(1)).toBeNull();
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle (multi)
    const span = dynDefs.findSpanContaining(1);
    expect(span).not.toBeNull();
    expect(span!.originIdx).toBe(1);
    expect(span!.spanLength).toBe(2);
    expect(adapter.setTextCalls.at(-1)).toBe('the legal eagle');
    expect(spanFillState.current).toBeNull(); // SpanFillState left alone
  });

  it('cycling a CJK sentence-cue replaces only its char span — preserves the rest of the buffer', async () => {
    // Regression (DATA LOSS, observed live on CC): cycling a Japanese
    // sentence-cue's rewrite wiped every OTHER sentence. CJK has no spaces,
    // so splitWords yields ONE word covering the whole buffer; the
    // word-derived splice range then replaced the WHOLE buffer. The cycle
    // must splice the def's char span [0,13), keeping the rest.
    const buffer = '今日はとても楽しかったよ。また一緒に遊ぼうね。';
    const { adapter, hlState, dynDefs } = await setupMw(buffer);
    dynDefs.set(0, {
      originalWord: '今日はとても楽しかったよ。',
      alternatives: ['今日はとても楽しかったよ。', '本日はとても楽しゅうございました。'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 13, // end of the first sentence (after 。)
      blankName: 'sentence-cue:more-formal',
    });
    hlState.activate(0, buffer);
    adapter.fireKey('up', { ctrl: true, alt: true });
    // First sentence → rewrite; the SECOND sentence must survive.
    expect(adapter.setTextCalls.at(-1)).toBe('本日はとても楽しゅうございました。また一緒に遊ぼうね。');
    expect(adapter.setTextCalls.at(-1)).toContain('また一緒に遊ぼうね。');
  });

  it('cycling a STALE CJK sentence-cue span ABORTS (no splice) — never corrupts the live buffer', async () => {
    // Race-guard (DATA LOSS): if the user edited between resolve and the
    // Ctrl+Alt+Up, the def's stored span [0,13] no longer holds its sentence.
    // The splice trusts those offsets verbatim, so without the guard it would
    // splice the rewrite at the wrong place. The cycle must ABORT (no setText)
    // — NOT fall back to the word-derived whole-buffer range (which is the
    // very wipe we're preventing). The def refreshes on the next resolve.
    const liveBuffer = 'すっかり別のテキストに変わったよ。'; // user replaced the buffer
    const { adapter, hlState, dynDefs } = await setupMw(liveBuffer);
    // A def whose span/text reflect the OLD (now-gone) buffer.
    dynDefs.set(0, {
      originalWord: '今日はとても楽しかったよ。',
      alternatives: ['今日はとても楽しかったよ。', '本日はとても楽しゅうございました。'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 13,
      blankName: 'sentence-cue:more-formal',
    });
    hlState.activate(0, liveBuffer);
    const callsBefore = adapter.setTextCalls.length;
    adapter.fireKey('up', { ctrl: true, alt: true });
    // No splice happened — the live buffer is untouched.
    expect(adapter.setTextCalls.length).toBe(callsBefore);
    expect(adapter.getText()).toBe(liveBuffer);
  });

  it('cycling a transform-blank whose buffer ends in a ZWNJ render-kick reverts cleanly (no span break)', async () => {
    // Live bug: a CJK transform-blank output ends with the ZWNJ render-kick
    // (looks like a trailing space). Cycling (Down → revert) used the
    // WORD-derived range, which pulls the trailing ZWNJ into the last word and
    // splices it inconsistently → the span breaks. Using the def's char span
    // (which excludes the render-kick char) makes the revert exact.
    const content = 'モダンなサイトの向上を図ります。';
    const original = 'improve the modern site _';
    const live = content + '‌'; // ZWNJ render-kick appended (the user's "looks like a space")
    const { adapter, hlState, dynDefs } = await setupMw(live);
    dynDefs.set(0, {
      originalWord: '_',
      alternatives: [content, original], // [current translation, revert target]
      currentIndex: 0,
      spanStart: 0,
      spanEnd: content.length, // span EXCLUDES the trailing ZWNJ
      blankName: 'transform-blank',
    });
    hlState.activate(0, live);
    adapter.fireKey('down', { ctrl: true, alt: true });
    // Reverts to the original; the trailing ZWNJ is preserved after the span,
    // and crucially the splice didn't corrupt the buffer.
    const result = adapter.setTextCalls.at(-1)!;
    expect(result.startsWith(original)).toBe(true);
    expect(result).not.toContain(content); // the Japanese was fully replaced, not partially
  });

  it('multi-paragraph CJK: cycling an EARLIER paragraph keeps LATER paragraphs splice-able (char-span shift)', async () => {
    // Regression (DATA CORRUPTION): in a multi-paragraph CJK buffer every
    // newline-separated paragraph is its own whitespace-word with its own
    // sentence-cue def. Cycling paragraph 1 to a LONGER rewrite shifts the
    // char offsets of paragraph 2 — but paragraph 2's def is LOCKED against
    // re-resolution (blankName guard), so without an explicit char-span
    // shift its stored [spanStart,spanEnd) stays stale and the NEXT cycle
    // on paragraph 2 splices the wrong range, corrupting the buffer.
    const para1 = '今日は楽しい。';
    const para2 = 'また来てね。';
    const buffer = `${para1}\n${para2}`;
    const p2Start = buffer.indexOf(para2); // 8
    const rewrite1 = '本日はまことに楽しゅうございました。'; // longer than para1
    const rewrite2 = 'またのお越しを心よりお待ち申し上げます。';
    const { adapter, hlState, dynDefs } = await setupMw(buffer);
    dynDefs.set(0, {
      originalWord: para1,
      alternatives: [para1, rewrite1],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: para1.length,
      blankName: 'sentence-cue:more-formal',
    });
    dynDefs.set(1, {
      originalWord: para2,
      alternatives: [para2, rewrite2],
      currentIndex: 0,
      spanStart: p2Start,
      spanEnd: p2Start + para2.length,
      blankName: 'sentence-cue:more-formal',
    });

    // Cycle paragraph 1 → its longer rewrite. Paragraph 2 must survive…
    hlState.activate(0, buffer);
    adapter.fireKey('up', { ctrl: true, alt: true });
    const afterFirst = adapter.setTextCalls.at(-1)!;
    expect(afterFirst).toBe(`${rewrite1}\n${para2}`);

    // …AND paragraph 2's def char span must have shifted to track the new
    // offsets (delta = rewrite1.length − para1.length).
    const delta = rewrite1.length - para1.length;
    const p2Def = dynDefs.get(1)!;
    expect(p2Def.spanStart).toBe(p2Start + delta);
    expect(p2Def.spanEnd).toBe(p2Start + para2.length + delta);
    // The shifted span points at paragraph 2 in the NEW buffer.
    expect(afterFirst.slice(p2Def.spanStart, p2Def.spanEnd)).toBe(para2);

    // Now cycle paragraph 2 — it must splice cleanly, preserving the
    // already-formal paragraph 1 (no corruption from a stale span).
    hlState.activate(1, afterFirst);
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe(`${rewrite1}\n${rewrite2}`);
  });

  it('cycling multi-word → multi-word keeps the span (DynDef updates)', async () => {
    const { adapter, hlState, dynDefs } = await setupMw('the attorney');
    hlState.activate(1, 'the attorney');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
    adapter.fireKey('up', { ctrl: true, alt: true }); // → defendant counsel
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
    expect(adapter.setTextCalls.at(-1)).toBe('the defendant counsel');
  });

  it('cycling multi-word → single-word collapses the span', async () => {
    const { adapter, hlState, dynDefs } = await setupMw('the attorney');
    hlState.activate(1, 'the attorney');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
    adapter.fireKey('up', { ctrl: true, alt: true }); // wraps to original (single)
    expect(adapter.setTextCalls.at(-1)).toBe('the attorney');
    expect(dynDefs.findSpanContaining(1)).toBeNull();
  });

  it('Ctrl+Alt+Up from inner span word redirects to origin and cycles whole span', async () => {
    const { adapter, hlState, dynDefs } = await setupMw('the ceo said');
    hlState.activate(1, 'the ceo said');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → Jeff Bezos (multi)
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
    expect(adapter.setTextCalls.at(-1)).toBe('the Jeff Bezos said');

    const before = adapter.setTextCalls.length;
    const currentText = adapter.setTextCalls.at(-1)!;
    hlState.activate(2, currentText); // inner span word (Bezos)
    adapter.fireKey('up', { ctrl: true, alt: true }); // forward → next multi-word alt
    expect(adapter.setTextCalls.length).toBeGreaterThan(before);
    // Span persists — cycled from inner position to next multi-word alt.
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
  });

  it('TWO concurrent multi-word spans coexist via DynDefs', async () => {
    // The bug option B exists to fix: SpanFillState held one slot,
    // so registering span B clobbered span A. With DynDefs as the
    // source, both spans live independently. Each span's origin DynDef
    // tracks its own alts + currentIndex.
    const { adapter, hlState, dynDefs } = await setupMw('the attorney said the ceo agrees');
    hlState.activate(1, 'the attorney said the ceo agrees');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // attorney → legal eagle
    expect(adapter.setTextCalls.at(-1)).toBe('the legal eagle said the ceo agrees');
    const spanA = dynDefs.findSpanContaining(1);
    expect(spanA?.spanLength).toBe(2);

    // After the cycle, "ceo" shifted from idx 4 to idx 5.
    const newText = adapter.setTextCalls.at(-1)!;
    hlState.activate(5, newText); // ceo at idx 5
    adapter.fireKey('up', { ctrl: true, alt: true }); // → Jeff Bezos
    expect(adapter.setTextCalls.at(-1)).toBe('the legal eagle said the Jeff Bezos agrees');
    // BOTH spans still active — no clobber.
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
    expect(dynDefs.findSpanContaining(5)?.spanLength).toBe(2);
  });

  it('cycling single → multi-word SHIFTS downstream DynDefs (no dim flicker)', async () => {
    // Regression: "dimmed words beyond the span lose their dimness"
    // after a multi-word cycle. Cause: DynDefs at idx > origin used
    // to be PRUNED when their originalWord no longer matched the
    // word at their old index — but that word had just shifted by
    // `delta`. Now we shift the def to its new index FIRST, then
    // prune anything still mismatched. Resolved-but-unrelated words
    // keep their dim across the cycle without waiting for the
    // resolver's debounce.
    const { adapter, hlState, dynDefs } = await setupMw('the attorney filed today');
    dynDefs.set(2, {
      originalWord: 'filed',
      alternatives: ['filed', 'submitted', 'lodged'],
      currentIndex: 0,
      spanStart: 13, spanEnd: 18,
    });
    hlState.activate(1, 'the attorney filed today');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → lawyer (single, no shift)
    expect(dynDefs.get(2)?.originalWord).toBe('filed');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle (multi, +1 shift)
    // "filed" moved from idx 2 to idx 3. DynDef follows.
    expect(dynDefs.get(2)).toBeUndefined();
    expect(dynDefs.get(3)?.originalWord).toBe('filed');
  });

  it('cycling multi-word → single-word SHIFTS downstream DynDefs back', async () => {
    const { adapter, hlState, dynDefs } = await setupMw('the attorney filed today');
    hlState.activate(1, 'the attorney filed today');
    // Cycle attorney → lawyer → legal eagle so we're in multi-word state.
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    // "filed" is now at idx 3 in "the legal eagle filed today".
    dynDefs.set(3, {
      originalWord: 'filed',
      alternatives: ['filed', 'submitted', 'lodged'],
      currentIndex: 0,
      spanStart: 16, spanEnd: 21,
    });
    // Cycle multi → multi (no shift), then back to single.
    adapter.fireKey('up', { ctrl: true, alt: true }); // → defendant counsel
    expect(dynDefs.get(3)?.originalWord).toBe('filed');
    adapter.fireKey('up', { ctrl: true, alt: true }); // wrap to attorney (single, -1 shift)
    expect(dynDefs.get(3)).toBeUndefined();
    expect(dynDefs.get(2)?.originalWord).toBe('filed'); // shifted left
  });

  it('swapping between multi-word alts splices at the correct char range', async () => {
    // Regression test for "SERIOUS bugs when we adjust spans …
    // positing words incorrectly when swapping out multiple word spans".
    // Root cause: applyAltCycle used to trust def.spanStart/spanEnd
    // which drifted across multi-word cycles. Now char range is
    // computed fresh from live word positions every cycle.
    const { adapter, hlState } = await setupMw('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → lawyer
    expect(adapter.setTextCalls.at(-1)).toBe('the lawyer filed');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle (multi)
    expect(adapter.setTextCalls.at(-1)).toBe('the legal eagle filed');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → defendant counsel (multi)
    expect(adapter.setTextCalls.at(-1)).toBe('the defendant counsel filed');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → attorney (wrap, single)
    expect(adapter.setTextCalls.at(-1)).toBe('the attorney filed');
    // Cycle the whole rotation once more — same shape every step.
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('the lawyer filed');
  });

  it('cycle multi → multi → single → multi correctly shrinks/grows the range', async () => {
    const { adapter, hlState } = await setupMw('the ceo said');
    hlState.activate(1, 'the ceo said');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → Jeff Bezos
    expect(adapter.setTextCalls.at(-1)).toBe('the Jeff Bezos said');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → Elon Musk
    expect(adapter.setTextCalls.at(-1)).toBe('the Elon Musk said');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → Tim Cook
    expect(adapter.setTextCalls.at(-1)).toBe('the Tim Cook said');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → ceo (wrap, single)
    expect(adapter.setTextCalls.at(-1)).toBe('the ceo said');
  });

  it('typing OUTSIDE the span preserves the DynDef (span words still match)', async () => {
    // User cycles attorney → legal eagle, then appends ' today'.
    // Pruning checks the multi-word alt's words still appear at the
    // span's index — they do (idx 1 = "legal", idx 2 = "eagle"),
    // so the DynDef + its implicit span survive.
    const { adapter, hlState, dynDefs } = await setupMw('the attorney');
    hlState.activate(1, 'the attorney');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);

    adapter.pushText('the legal eagle today');
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
  });

  it('prepending text RELOCATES the def to its new contiguous position', async () => {
    // pruneStale runs deterministic relocate: when a stale def's
    // currentAlt's words still appear at exactly one new position,
    // the def MOVES instead of being dropped. User keeps their cycle
    // progress through prefix edits.
    const { adapter, hlState, dynDefs } = await setupMw('the attorney');
    hlState.activate(1, 'the attorney');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);

    adapter.pushText('hey there the legal eagle');
    // Def relocated from idx 1 → idx 3 (where "legal eagle" now lives).
    expect(dynDefs.get(1)).toBeUndefined();
    expect(dynDefs.get(3)?.originalWord).toBe('attorney');
    expect(dynDefs.findSpanContaining(3)?.spanLength).toBe(2);
  });

  it('destroying the span text drops the DynDef', async () => {
    const { adapter, hlState, dynDefs } = await setupMw('the attorney');
    hlState.activate(1, 'the attorney');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);

    adapter.pushText('the cat jumped');
    expect(dynDefs.get(1)).toBeUndefined();
    expect(dynDefs.findSpanContaining(1)).toBeNull();
  });
});

describe('Cycling consume-all', () => {
  async function setupCa(initialText: string) {
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': TIPS } });
    adapter.pushText(initialText);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const consumeAll = new SpanFillState();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, consumeAll);
    cycling.subscribe();
    return { adapter, hlState, consumeAll, cycling };
  }

  it('cycles forward through stashed alternatives', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Improved one');
    consumeAll.set({
      index: 0,
      alternatives: ['Improved one', 'Improved two version', 'Final three'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Improved one');
    hlState.activate(0, 'Improved one');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('Improved two version');
    expect(consumeAll.current?.currentAltIndex).toBe(1);
    expect(consumeAll.current?.spanLength).toBe(3);
  });

  it('cycles backward (Ctrl+Alt+Down)', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Improved one');
    consumeAll.set({
      index: 0,
      alternatives: ['Improved one', 'Improved two version', 'Final three'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Improved one');
    hlState.activate(0, 'Improved one');
    expect(adapter.fireKey('down', { ctrl: true, alt: true })).toBe(true);
    // Wraps from 0 down to 2 (last alt)
    expect(adapter.setTextCalls.at(-1)).toBe('Final three');
    expect(consumeAll.current?.currentAltIndex).toBe(2);
  });

  it('only cycles when highlight is within the consumed span', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Improved one outside word');
    consumeAll.set({
      index: 0,
      alternatives: ['Improved one', 'Other version'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Improved one outside word');
    // Word index 3 ("word") is outside the span [0, 2)
    hlState.activate(3, 'Improved one outside word');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
    expect(adapter.setTextCalls).toEqual([]);
  });

  it('updates lastFilledText so post-cycle text changes do not invalidate', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Improved one');
    consumeAll.set({
      index: 0,
      alternatives: ['Improved one', 'Other version'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Improved one');
    hlState.activate(0, 'Improved one');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(consumeAll.lastFilledText).toBe('Other version');
    expect(consumeAll.current).not.toBeNull();
  });

  it('cycling to `_` adds slot to DismissedBlanks; cycling away removes it', async () => {
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': TIPS } });
    adapter.pushText('foo');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const span = new SpanFillState();
    const dismissed = new DismissedBlanks();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, span, dismissed);
    cycling.subscribe();
    span.set({
      index: 0,
      alternatives: ['foo', 'bar', '_'],
      currentAltIndex: 0,
      spanLength: 1,
    }, 'foo');
    hlState.activate(0, 'foo');
    // Cycle 0→1: foo → bar (not `_`)
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dismissed.has(0)).toBe(false);
    // Cycle 1→2: bar → `_`
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dismissed.has(0)).toBe(true);
    // Cycle 2→0: `_` → foo
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dismissed.has(0)).toBe(false);
  });

  it('cycling selector rotates setting names + spawns get script', async () => {
    const OPENCUES_MD = `---
voice-mode: active
debug-mode: off
settings:
  voice-mode:
    tip: Gates TTS globally
    values:
      active: TTS reads tips aloud
      inactive: TTS silenced
  debug-mode:
    tip: Debug logging
    values:
      on: emit
      off: silent
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': OPENCUES_MD },
    });
    adapter.pushText('voice-mode active');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 1,
      currentSetting: 'voice-mode',
      currentValue: 'active',
      separator: ' ',
      clearOnEdit: false,
    }, 'voice-mode active');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'off\n', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    hlState.activate(0, 'voice-mode active'); // selector
    adapter.setCursorOffset('voice-mode'.length); // cursor on selector word, end-of-word
    adapter.fireKey('up', { ctrl: true, alt: true });
    // Synchronous part: text now has the next setting name + first declared value.
    expect(adapter.setTextCalls.at(-1)).toBe('debug-mode on');
    expect(ss.current?.currentSetting).toBe('debug-mode');
    // Async script `get debug-mode` was spawned.
    expect(spawnSpy).toHaveBeenCalled();
    expect(spawnSpy.mock.calls[0][0].args).toEqual(['/tmp/oc.sh', 'get', 'debug-mode']);
    // Cursor lands at end of the NEW selector ('debug-mode' is 10 chars,
    // ending at offset 10), NOT at end of the new region (would be 13 —
    // past 'on'). Why this matters: under cursor-navigate, snapping past
    // the satellite would auto-highlight whatever word follows the pair
    // on the next render, throwing focus off the selector the user was
    // cycling. Multi-word selectors share this rule (end of last
    // selector word).
    expect(adapter.setCursorCalls.at(-1)).toBe('debug-mode'.length);
  });

  it('selector cycle SKIPS settings without values (free-text scalars like color lists)', async () => {
    // User-reported bug: `opencues settings _` cycling broke after
    // we added blank-loading-colors-rgb / -ansi to the settings:
    // schema. Those scalars have a `tip:` but no `values:` block
    // (the value is a free-text comma list, not enumerable). The old
    // cycler iterated ALL keys → hit a no-values setting → emitted
    // an empty satellite → pair shape collapsed. Filter to settings
    // with `valueOrder.length > 0` only.
    const OPENCUES_MD = `---
voice-mode: active
debug-mode: off
settings:
  voice-mode:
    tip: Gates TTS
    values:
      active: a
      inactive: i
  blank-loading-colors-rgb:
    tip: Per-frame RGB. Free text — no values: block.
  debug-mode:
    tip: Debug
    values:
      on: emit
      off: silent
  blank-loading-colors-ansi:
    tip: Per-frame ANSI. Free text.
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': OPENCUES_MD },
    });
    adapter.pushText('voice-mode active');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 1,
      currentSetting: 'voice-mode',
      currentValue: 'active',
      separator: ' ',
      clearOnEdit: false,
    }, 'voice-mode active');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'off\n', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    hlState.activate(0, 'voice-mode active');
    adapter.setCursorOffset('voice-mode'.length);

    // Cycle forward. blank-loading-colors-rgb sits between voice-mode
    // and debug-mode in declaration order. The fix MUST skip it and
    // land us on debug-mode directly. No setText should contain a
    // trailing space (empty satellite) or 'blank-loading-colors-rgb'
    // as a selector.
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('debug-mode on');
    expect(ss.current?.currentSetting).toBe('debug-mode');

    // Continue cycling forward; blank-loading-colors-ansi follows
    // debug-mode in declaration order — also a free-text setting,
    // also must be skipped. So next-after-debug-mode wraps to
    // voice-mode (the only other cyclable setting).
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('voice-mode active');
    expect(ss.current?.currentSetting).toBe('voice-mode');

    // No setText emitted along the way contains a free-text setting
    // name as the selector — the regression fence.
    for (const call of adapter.setTextCalls) {
      expect(call).not.toMatch(/blank-loading-colors-/);
    }
  });

  it('selector cycle ALWAYS lands cursor on selector (cursor-was-at-0 / cursor-was-past-region)', async () => {
    // User-reported bug: cursor at 0 → selector cycle "throws cursor
    // to start of text" (= cursor stays at 0). And cursor past the
    // region drifts cycle-by-cycle as length deltas accumulate.
    // The fix: cycling tracks the WORD, not edit semantics — cursor
    // always lands at end-of-new-selector regardless of where it was.
    const OPENCUES_MD = `---
voice-mode: active
debug-mode: off
settings:
  voice-mode:
    tip: t
    values:
      active: a
      inactive: i
  debug-mode:
    tip: t
    values:
      on: o
      off: f
---`;
    const setup = (initialCursor: number): { adapter: MockAdapter; ss: SelectorSatelliteState; hlState: HighlightState } => {
      const adapter = new MockAdapter({
        cwd: '/proj',
        files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': OPENCUES_MD },
      });
      adapter.pushText('voice-mode active');
      const hlState = new HighlightState();
      const dynDefs = new DynDefs();
      const ss = new SelectorSatelliteState();
      ss.set({
        blankName: 'opencues', scriptPath: '/tmp/oc.sh',
        selectorIndex: 0, selectorLength: 1,
        satelliteIndex: 1, satelliteLength: 1,
        currentSetting: 'voice-mode', currentValue: 'active',
        separator: ' ', clearOnEdit: false,
      }, 'voice-mode active');
      const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
      // load synchronously — pre-load opencuesState used by cycling.
      void loader.load();
      const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
      cycling.subscribe();
      vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
        result: Promise.resolve({ exitCode: 0, stdout: 'off\n', stderr: '', timedOut: false }),
        kill: () => {},
      }));
      hlState.activate(0, 'voice-mode active'); // selector
      adapter.setCursorOffset(initialCursor);
      return { adapter, ss, hlState };
    };

    // Case 1: cursor at offset 0 (start of selector). Old preservedCursor
    // returned cursor unchanged (case `<= oldStart`); user perceived this
    // as cursor "thrown to start of text".
    {
      const { adapter } = setup(0);
      await new Promise(r => setImmediate(r));
      adapter.fireKey('up', { ctrl: true, alt: true });
      expect(adapter.setCursorCalls.at(-1)).toBe('debug-mode'.length);
    }

    // Case 2: cursor at end of "active" (offset 17). Old preservedCursor
    // shifted by length delta; cursor drifted to end of new region
    // (offset 13), then 12, then 11 across consecutive cycles.
    {
      const { adapter, ss } = setup(17);
      await new Promise(r => setImmediate(r));
      adapter.fireKey('up', { ctrl: true, alt: true });
      expect(adapter.setCursorCalls.at(-1)).toBe('debug-mode'.length);
      // Second cycle: cursor MUST land at end-of-new-selector again,
      // not drift further.
      adapter.fireKey('up', { ctrl: true, alt: true });
      expect(adapter.setCursorCalls.at(-1)).toBe(ss.current!.currentSetting.length);
    }
  });

  it('cycling satellite rotates values + spawns set script', async () => {
    const OPENCUES_MD = `---
voice-mode: active
settings:
  voice-mode:
    tip: t
    values:
      active: a
      inactive: i
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': OPENCUES_MD },
    });
    adapter.pushText('voice-mode active');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 1,
      currentSetting: 'voice-mode',
      currentValue: 'active',
      separator: ' ',
      clearOnEdit: false,
    }, 'voice-mode active');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    hlState.activate(1, 'voice-mode active'); // satellite
    adapter.setCursorOffset('voice-mode active'.length); // cursor on satellite, end-of-word
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('voice-mode inactive');
    expect(ss.current?.currentValue).toBe('inactive');
    expect(spawnSpy.mock.calls[0][0].args).toEqual(['/tmp/oc.sh', 'set', 'voice-mode', 'inactive']);
    expect(spawnSpy.mock.calls[0][0].detached).toBe(true);
    // Satellite cycle keeps the cursor on the satellite word — landing
    // at end of 'inactive' (= end of region, 'voice-mode inactive'
    // length 19). Symmetry with the selector cycle: each cycle direction
    // keeps the cursor on the word the user was cycling.
    expect(adapter.setCursorCalls.at(-1)).toBe('voice-mode inactive'.length);
  });

  it('satellite cycle handles multi-word values (e.g. plain text → rich markdown)', async () => {
    const OPENCUES_MD = `---
output-format: plain text
settings:
  output-format:
    tip: Format
    values:
      plain text: a
      rich markdown: b
      structured json: c
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': OPENCUES_MD },
    });
    adapter.pushText('output-format plain text');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 2,
      currentSetting: 'output-format',
      currentValue: 'plain text',
      separator: ' ',
      clearOnEdit: false,
    }, 'output-format plain text');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    vi.spyOn(adapter, 'spawnProcess');
    hlState.activate(1, 'output-format plain text'); // first satellite word
    adapter.fireKey('up', { ctrl: true, alt: true });
    // Should replace the WHOLE "plain text" with "rich markdown".
    expect(adapter.setTextCalls.at(-1)).toBe('output-format rich markdown');
    expect(ss.current?.currentValue).toBe('rich markdown');
    expect(ss.current?.satelliteLength).toBe(2);
  });

  it('cycling from inside a multi-word satellite still triggers cycle', async () => {
    const OPENCUES_MD = `---
output-format: plain text
settings:
  output-format:
    tip: Format
    values:
      plain text: a
      structured json: b
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': OPENCUES_MD },
    });
    adapter.pushText('output-format plain text');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues',
      scriptPath: '',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 2,
      currentSetting: 'output-format',
      currentValue: 'plain text',
      separator: ' ',
      clearOnEdit: false,
    }, 'output-format plain text');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    hlState.activate(2, 'output-format plain text'); // SECOND satellite word ("text")
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('output-format structured json');
  });

  it('multi-word selector + satellite cycle as units (display mode case)', async () => {
    const OPENCUES_MD = `---
display mode: split pane
settings:
  display mode:
    tip: Layout
    values:
      focus: f
      split pane: s
      zen: z
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': OPENCUES_MD },
    });
    adapter.pushText('display mode split pane');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues',
      scriptPath: '',
      selectorIndex: 0,
      selectorLength: 2,
      satelliteIndex: 2,
      satelliteLength: 2,
      currentSetting: 'display mode',
      currentValue: 'split pane',
      separator: ' ',
      clearOnEdit: false,
    }, 'display mode split pane');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    // Cycle satellite from "split pane" → "zen" (single word).
    hlState.activate(2, 'display mode split pane'); // first satellite word
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('display mode zen');
    expect(ss.current?.currentValue).toBe('zen');
    expect(ss.current?.satelliteLength).toBe(1);
    // Now satellite is single word; cycle again → "focus".
    hlState.activate(2, 'display mode zen');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('display mode focus');
    expect(ss.current?.satelliteLength).toBe(1);
  });

  it('does nothing when there is only one alternative', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Lone version');
    consumeAll.set({
      index: 0,
      alternatives: ['Lone version'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Lone version');
    hlState.activate(0, 'Lone version');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
  });
});

describe('Cycling blankInvoke (sandboxed-host path)', () => {
  it('selector cycle prefers blankInvoke when host implements it', async () => {
    const OPENCUES_MD = `---
voice-mode: active
debug-mode: off
settings:
  voice-mode:
    tip: Gates TTS globally
    values:
      active: TTS reads tips aloud
      inactive: TTS silenced
  debug-mode:
    tip: Debug logging
    values:
      on: emit
      off: silent
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': OPENCUES_MD },
    });
    adapter.pushText('voice-mode active');
    // Host stubs blankInvoke for the selector get; spawn must NOT be hit.
    adapter.stubBlankInvoke('opencues:get', 'off\n');
    const hlState = new HighlightState();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 1,
      currentSetting: 'voice-mode',
      currentValue: 'active',
      separator: ' ',
      clearOnEdit: false,
    }, 'voice-mode active');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, new DynDefs(), loader, undefined, undefined, ss);
    cycling.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    hlState.activate(0, 'voice-mode active');
    adapter.fireKey('up', { ctrl: true, alt: true });
    // blankInvoke was called for the selector get; spawnProcess wasn't.
    const getCall = adapter.blankInvokeCalls.find(c => c.action === 'get');
    expect(getCall).toBeDefined();
    expect(getCall!.blankName).toBe('opencues');
    expect(getCall!.args).toEqual(['debug-mode']);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('falls through to spawnProcess when host returns null from blankInvoke', async () => {
    const OPENCUES_MD = `---
voice-mode: active
settings:
  voice-mode:
    tip: t
    values:
      active: a
      inactive: i
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': OPENCUES_MD },
    });
    adapter.pushText('voice-mode active');
    // No stub registered → blankInvoke returns null → spawnProcess used.
    const hlState = new HighlightState();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 1,
      currentSetting: 'voice-mode',
      currentValue: 'active',
      separator: ' ',
      clearOnEdit: false,
    }, 'voice-mode active');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, new DynDefs(), loader, undefined, undefined, ss);
    cycling.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'a\n', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    hlState.activate(0, 'voice-mode active');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(spawnSpy).toHaveBeenCalled();
  });
});

describe('Cycling — satellite cycle FILTERS llm-provider values whose env key is unset', () => {
  // Pins the "test BEFORE you switch" invariant the user named: cycling
  // a `*-llm-provider` scalar MUST skip values whose env key isn't
  // present in the bag passed via `getApiKeys`. Mirrors chrome's popup,
  // which already drops un-keyed providers from its dropdown via
  // `isKeyValid()`. Without the filter, Ctrl+Alt+Up could land on
  // `groq` while GROQ_API_KEY is unset → next `_` silently no-ops
  // until the user reads `/tmp/opencues.log`. With it, the cycle steps
  // directly to the next eligible value (or falls back to `inherit`).

  const SETTINGS_MD = `---
blanks-llm-provider: inherit
settings:
  blanks-llm-provider:
    tip: Provider for blank-class sources.
    values:
      inherit: Default
      groq: Groq
      cerebras: Cerebras
      anthropic: Anthropic
      openai: OpenAI
      gemini: Gemini
---`;

  async function setup(apiKeys: Record<string, string | undefined>) {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': SETTINGS_MD },
    });
    adapter.pushText('blanks-llm-provider inherit');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 1,
      currentSetting: 'blanks-llm-provider',
      currentValue: 'inherit',
      separator: ' ',
      clearOnEdit: false,
    }, 'blanks-llm-provider inherit');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(
      adapter, hlState, dynDefs, loader,
      undefined, undefined, ss,
      () => apiKeys,
    );
    cycling.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    return { adapter, hlState, ss };
  }

  it('with no keys set, satellite cycle stays on the only eligible value (inherit)', async () => {
    const { adapter, hlState } = await setup({});
    hlState.activate(1, 'blanks-llm-provider inherit'); // satellite word
    adapter.setCursorOffset('blanks-llm-provider inherit'.length);
    // Up should walk: inherit -> (skip groq/cerebras/anthropic/openai/gemini, all unkeyed) -> wrap to inherit.
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('blanks-llm-provider inherit');
  });

  it('with GROQ_API_KEY set, satellite cycle Up walks inherit → groq', async () => {
    const { adapter, hlState } = await setup({ GROQ_API_KEY: 'gsk_test' });
    hlState.activate(1, 'blanks-llm-provider inherit');
    adapter.setCursorOffset('blanks-llm-provider inherit'.length);
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('blanks-llm-provider groq');
  });

  it('with GROQ + CEREBRAS set, satellite cycle SKIPS unkeyed anthropic/openai/gemini', async () => {
    const { adapter, hlState } = await setup({
      GROQ_API_KEY: 'gsk_test',
      CEREBRAS_API_KEY: 'csk_test',
    });
    hlState.activate(1, 'blanks-llm-provider inherit');
    adapter.setCursorOffset('blanks-llm-provider inherit'.length);
    // inherit → groq → cerebras → wrap to inherit (anthropic/openai/gemini all skipped).
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('blanks-llm-provider groq');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('blanks-llm-provider cerebras');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('blanks-llm-provider inherit');
  });

  it('Down walks the eligible set in reverse', async () => {
    const { adapter, hlState } = await setup({
      GROQ_API_KEY: 'gsk_test',
      CEREBRAS_API_KEY: 'csk_test',
    });
    hlState.activate(1, 'blanks-llm-provider inherit');
    adapter.setCursorOffset('blanks-llm-provider inherit'.length);
    // Down: inherit → cerebras → groq → inherit.
    adapter.fireKey('down', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('blanks-llm-provider cerebras');
    adapter.fireKey('down', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('blanks-llm-provider groq');
  });

  it('without getApiKeys (back-compat default), cycling stays blind — all values eligible', async () => {
    // Mirrors the pre-June 2026 behaviour. Hosts that DON'T thread
    // apiKeys (or third-party adapters that haven't updated yet) keep
    // the original "cycle through every registry-declared value"
    // semantic. The inline-error substitute (#65) is the safety net.
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': SETTINGS_MD },
    });
    adapter.pushText('blanks-llm-provider inherit');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues', scriptPath: '/tmp/oc.sh',
      selectorIndex: 0, selectorLength: 1,
      satelliteIndex: 1, satelliteLength: 1,
      currentSetting: 'blanks-llm-provider', currentValue: 'inherit',
      separator: ' ', clearOnEdit: false,
    }, 'blanks-llm-provider inherit');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    // NO getApiKeys argument — filter disabled.
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    hlState.activate(1, 'blanks-llm-provider inherit');
    adapter.setCursorOffset('blanks-llm-provider inherit'.length);
    adapter.fireKey('up', { ctrl: true, alt: true });
    // No filter → cycle takes the literal next value (groq), regardless
    // of env state.
    expect(adapter.setTextCalls.at(-1)).toBe('blanks-llm-provider groq');
  });

  it('NEVER collapses to empty — when zero values would be eligible, falls back to unfiltered list', async () => {
    // Defensive: if a config pack adds an `*-llm-provider` scalar whose
    // values are ALL un-keyed (and inherit isn't in the list), cycling
    // would have nothing to step to. The filter falls back to the
    // unfiltered list so the cycle still moves SOMEWHERE; the runtime
    // then surfaces the resulting LLM-call failure inline rather than
    // freezing the menu on the same value forever.
    const NO_INHERIT_MD = `---
blanks-llm-provider: groq
settings:
  blanks-llm-provider:
    tip: Provider for blank-class sources.
    values:
      groq: Groq
      anthropic: Anthropic
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': NO_INHERIT_MD },
    });
    adapter.pushText('blanks-llm-provider groq');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues', scriptPath: '/tmp/oc.sh',
      selectorIndex: 0, selectorLength: 1,
      satelliteIndex: 1, satelliteLength: 1,
      currentSetting: 'blanks-llm-provider', currentValue: 'groq',
      separator: ' ', clearOnEdit: false,
    }, 'blanks-llm-provider groq');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(
      adapter, hlState, dynDefs, loader,
      undefined, undefined, ss,
      () => ({}), // no keys
    );
    cycling.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    hlState.activate(1, 'blanks-llm-provider groq');
    adapter.setCursorOffset('blanks-llm-provider groq'.length);
    adapter.fireKey('up', { ctrl: true, alt: true });
    // Both values are unkeyed → filter would collapse to empty → safety
    // net falls back to unfiltered values → cycle steps to next literal
    // (anthropic). The inline-error substitute will surface the issue
    // on the next `_`.
    expect(adapter.setTextCalls.at(-1)).toBe('blanks-llm-provider anthropic');
  });

  it('non-provider scalars (e.g. voice-mode) are NOT filtered — only *-llm-provider gates', async () => {
    // The filter scope is narrow on purpose: cycling voice-mode /
    // debug-mode / tips-mode etc. must keep working unchanged regardless
    // of which API keys are set.
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': `---
voice-mode: active
settings:
  voice-mode:
    tip: Gates TTS
    values:
      active: a
      inactive: i
---` },
    });
    adapter.pushText('voice-mode active');
    const hlState = new HighlightState();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues', scriptPath: '/tmp/oc.sh',
      selectorIndex: 0, selectorLength: 1,
      satelliteIndex: 1, satelliteLength: 1,
      currentSetting: 'voice-mode', currentValue: 'active',
      separator: ' ', clearOnEdit: false,
    }, 'voice-mode active');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    // getApiKeys returns empty — but voice-mode isn't a provider scalar.
    const cycling = new Cycling(
      adapter, hlState, new DynDefs(), loader,
      undefined, undefined, ss,
      () => ({}),
    );
    cycling.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    hlState.activate(1, 'voice-mode active');
    adapter.setCursorOffset('voice-mode active'.length);
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('voice-mode inactive');
  });
});

describe('_-cycle — bare `_` inside a painted cue note rotates the cue', () => {
  // A passive cue (sentence-cue / contradiction) registers a def with a cueTip.
  // When the note is painted (inline-cues-mode: inline + inline-note capability)
  // and the caret is in the span, `_` rotates it forward and is CONSUMED.
  function seedCueDef(dynDefs: DynDefs, spanEnd = 13) {
    dynDefs.set(0, {
      originalWord: 'thanks a lot.',
      alternatives: ['thanks a lot.', 'Thank you very much.', 'Much appreciated.'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd,
      blankName: 'sentence-cue:more-formal',
      cueTip: 'more-formal',
    });
  }

  it('bare `_` inside the span rotates forward AND consumes the key', async () => {
    const { adapter, dynDefs } = await setup('thanks a lot.');
    seedCueDef(dynDefs);
    adapter.setCursorOffset(5); // inside [0,13]
    expect(adapter.fireKey('_')).toBe(true); // consumed → not inserted
    expect(adapter.setTextCalls.at(-1)).toBe('Thank you very much.');
    expect(dynDefs.get(0)?.currentIndex).toBe(1);
    // `_`-step lands the caret at the span END, tucked against the last char
    // ('Thank you very much.' = 20 chars), ready to keep typing.
    expect(adapter.getCursorOffset()).toBe(20);
  });

  it('successive `_` presses step forward and WRAP back to the original', async () => {
    const { adapter, dynDefs } = await setup('thanks a lot.');
    seedCueDef(dynDefs);
    adapter.setCursorOffset(5);
    adapter.fireKey('_'); // → alt1
    adapter.fireKey('_'); // → alt2
    expect(dynDefs.get(0)?.currentIndex).toBe(2);
    adapter.fireKey('_'); // 3 alts → wrap to original
    expect(dynDefs.get(0)?.currentIndex).toBe(0);
    expect(adapter.setTextCalls.at(-1)).toBe('thanks a lot.');
  });

  it('does NOT consume `_` when the caret is OUTSIDE the span (blank path intact)', async () => {
    const { adapter, dynDefs } = await setup('thanks a lot. bye');
    seedCueDef(dynDefs); // span [0,13]
    adapter.setCursorOffset(15); // past the span → in " bye"
    expect(adapter.fireKey('_')).toBe(false); // falls through to the normal `_`
    expect(adapter.setTextCalls).toEqual([]); // no cycle
  });

  it('does NOT consume `_` for a NON-note-bearing def (single alternative, nothing to cycle)', async () => {
    // A more-formal sentence cue WITH alternatives is now note-bearing (it shows
    // `N | Improve formality` and is `_`-cycleable) — so the non-consume case is
    // a def with nothing to offer: a single alternative → inlineNoteText returns
    // undefined → not note-bearing → `_` falls through to the normal blank path.
    const { adapter, dynDefs } = await setup('thanks a lot.');
    dynDefs.set(0, {
      originalWord: 'thanks a lot.',
      alternatives: ['thanks a lot.'], // only the original → nothing to cycle → no note
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 13,
      blankName: 'sentence-cue:more-formal',
    });
    adapter.setCursorOffset(5);
    expect(adapter.fireKey('_')).toBe(false);
    expect(adapter.setTextCalls).toEqual([]);
  });

  it('does NOT consume `_` when a modifier is held (bare `_` only)', async () => {
    const { adapter, dynDefs } = await setup('thanks a lot.');
    seedCueDef(dynDefs);
    adapter.setCursorOffset(5);
    expect(adapter.fireKey('_', { ctrl: true })).toBe(false);
    expect(adapter.fireKey('_', { alt: true })).toBe(false);
    expect(adapter.setTextCalls).toEqual([]);
  });

  it('does NOT consume `_` in secondary mode (note not painted → `_` stays a blank)', async () => {
    const adapter = new MockAdapter({ files: { '/mock/OPENCUES.md': '---\ninline-cues-mode: secondary\n---\n' } });
    adapter.pushText('thanks a lot.');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/mock/OPENCUES.md' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader);
    cycling.subscribe();
    seedCueDef(dynDefs);
    adapter.setCursorOffset(5);
    expect(adapter.fireKey('_')).toBe(false);
    expect(adapter.setTextCalls).toEqual([]);
  });

  it('`_` walks a transform-blank HISTORY (not just sentence-cues)', async () => {
    // A transform/fluid blank accumulates a walkable history in `alternatives`
    // (the findChainableLlmDef chain). It has NO cueTip — its note comes from
    // inlineNoteText's transform-blank branch. `_` steps the history.
    const { adapter, dynDefs } = await setup('日本語');
    dynDefs.set(0, {
      originalWord: 'thanks',
      alternatives: ['日本語', 'formal english', 'thanks a lot'], // newest → older
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 3, // '日本語' is 3 chars
      blankName: 'transform-blank',
      // no cueTip
    });
    adapter.setCursorOffset(1); // inside [0,3]
    expect(adapter.fireKey('_')).toBe(true); // consumed
    expect(dynDefs.get(0)?.currentIndex).toBe(1);
    expect(adapter.setTextCalls.at(-1)).toBe('formal english');
    // caret lands at the span END of the new alt ('formal english' = 14 chars).
    expect(adapter.getCursorOffset()).toBe(14);
  });

  it('does NOT `_`-cycle a fluid/transform blank with a single alternative', async () => {
    const { adapter, dynDefs } = await setup('sunny');
    dynDefs.set(0, {
      originalWord: 'sunny',
      alternatives: ['sunny'], // no history yet → nothing to step
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 5,
      blankName: 'fluid-blank',
    });
    adapter.setCursorOffset(2);
    expect(adapter.fireKey('_')).toBe(false);
    expect(adapter.setTextCalls).toEqual([]);
  });

  // The uniform note model made filled blanks + selector-satellite note-bearing;
  // `_`-cycle must reach them too (they're not DynDefs, so a separate branch).
  it('bare `_` inside a filled list/script blank span rotates it forward (SpanFillState)', async () => {
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': TIPS } });
    adapter.pushText('80%');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const spanFillState = new SpanFillState();
    spanFillState.set({
      index: 0,
      alternatives: ['80%', '60%', '100%'],
      currentAltIndex: 0,
      spanLength: 1,
      tip: 'system volume',
      clearOnEdit: false,
    }, '80%');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, spanFillState);
    cycling.subscribe();
    adapter.setCursorOffset(1); // inside the filled span [0,3]
    expect(adapter.fireKey('_')).toBe(true); // consumed, not inserted
    expect(adapter.setTextCalls.at(-1)).toBe('60%');
    expect(spanFillState.current?.currentAltIndex).toBe(1);
  });

  it('bare `_` on the selector part cycles setting NAMES (SelectorSatelliteState, cursor-aware)', async () => {
    const OPENCUES_MD = `---
voice-mode: active
debug-mode: off
settings:
  voice-mode:
    tip: Gates TTS
    values:
      active: a
      inactive: i
  debug-mode:
    tip: Debug
    values:
      on: emit
      off: silent
---`;
    const adapter = new MockAdapter({ cwd: '/proj', files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': OPENCUES_MD } });
    adapter.pushText('voice-mode active');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues', scriptPath: '/tmp/oc.sh',
      selectorIndex: 0, selectorLength: 1, satelliteIndex: 1, satelliteLength: 1,
      currentSetting: 'voice-mode', currentValue: 'active', separator: ' ', clearOnEdit: false,
    }, 'voice-mode active');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'off\n', stderr: '', timedOut: false }), kill: () => {},
    }));
    adapter.setCursorOffset(3); // caret on the selector word 'voice-mode' [0,10]
    expect(adapter.fireKey('_')).toBe(true); // consumed → not inserted
    expect(ss.current?.currentSetting).toBe('debug-mode');
    expect(adapter.setTextCalls.at(-1)).toBe('debug-mode on');
  });

  it('bare `_` on the satellite part cycles that setting\'s VALUES (SelectorSatelliteState, cursor-aware)', async () => {
    const OPENCUES_MD = `---
voice-mode: active
settings:
  voice-mode:
    tip: Gates TTS
    values:
      active: a
      inactive: i
---`;
    const adapter = new MockAdapter({ cwd: '/proj', files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': OPENCUES_MD } });
    adapter.pushText('voice-mode active');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues', scriptPath: '/tmp/oc.sh',
      selectorIndex: 0, selectorLength: 1, satelliteIndex: 1, satelliteLength: 1,
      currentSetting: 'voice-mode', currentValue: 'active', separator: ' ', clearOnEdit: false,
    }, 'voice-mode active');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false }), kill: () => {},
    }));
    adapter.setCursorOffset('voice-mode active'.length - 2); // caret on the satellite word 'active'
    expect(adapter.fireKey('_')).toBe(true); // consumed → not inserted
    expect(ss.current?.currentValue).toBe('inactive');
    expect(adapter.setTextCalls.at(-1)).toBe('voice-mode inactive');
  });
});
