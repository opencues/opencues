/**
 * UX journey scenarios for the `note` collection blank (PROTOTYPE —
 * issue #210). These drive the REAL NoteBlank through the REAL
 * BlankFill/Cycling pipeline (no stubs, no LLM — the blank is fully
 * deterministic), simulating the user journeys the feature exists
 * for. Each scenario asserts what the BUFFER looks like at every
 * step — the buffer IS the UX.
 *
 * The canonical journey is the issue's own story: a user saves a
 * gnarly ffmpeg repair command once, then later recalls it with two
 * words and tweaks a filename in place.
 */

import { describe, expect, it } from 'vitest';
import { BlankFill } from './blank-fill';
import { Cycling } from './cycling';
import { ConfigLoader } from './config-loader';
import { MockAdapter, wrapTipsAsCuesMd } from '../../testing/mock-adapter';
import { SpanFillState } from '../state/span-fill';
import { DynDefs } from '../state/dyn-defs';
import { HighlightState } from '../state/highlight-state';
import { createBlankInvoke, createDefaultBlanksRegistry } from '../blanks';

const TIPS = wrapTipsAsCuesMd({ concepts: [] });

// Mirrors defaults/blanks/note/BLANK.md (the UX-relevant frontmatter).
const NOTE_CUE = `---
type: blank
name: note
blankKeywords: note
blankDismissible: true
blankClearKeywords: true
---
`;

const FFMPEG_BODY = 'ffmpeg -fflags +genpts -err_detect ignore_err -i input.mp4 -c copy output.mp4';

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };

async function setupNotes(initialNotes: string | null = null) {
  let notesFile = initialNotes;
  const notesMdIO = {
    readFile: async () => notesFile,
    writeFile: async (c: string) => { notesFile = c; },
  };
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: {
      '/mock/CUES.md': TIPS,
      '/proj/blanks/note/BLANK.md': NOTE_CUE,
    },
    // note is a runtime-class blank with no blankScript — dispatch
    // requires the host to advertise blank-invoke (chrome-style),
    // which isn't in MockAdapter's DEFAULT_CAPS.
    capabilities: [
      'shimmer', 'render-override', 'dim-ranges', 'highlight-range',
      'selection', 'spawn-process', 'file-read', 'file-write',
      'force-render', 'change-source', 'blank-invoke',
    ],
  });
  const registry = createDefaultBlanksRegistry({ notesMdIO });
  const invoke = createBlankInvoke(registry);
  (adapter as unknown as { blankInvoke: typeof invoke }).blankInvoke = invoke;

  const loader = new ConfigLoader(adapter);
  await loader.load();
  const spanFillState = new SpanFillState();
  const dynDefs = new DynDefs();
  const hlState = new HighlightState();
  const cycling = new Cycling(adapter, hlState, dynDefs, loader, spanFillState);
  cycling.subscribe();
  const bf = new BlankFill(adapter, loader, spanFillState, undefined, undefined, dynDefs);
  bf.subscribe();
  return {
    adapter, loader, bf, cycling, spanFillState, dynDefs, hlState,
    notes: () => notesFile,
  };
}

describe('note blank — the issue #210 journey (save → recall → tweak)', () => {
  it('add: command span consumed, visible confirmation, bullet persisted', async () => {
    const s = await setupNotes();
    s.adapter.pushText(`note add fix mp4: ${FFMPEG_BODY} _`);
    await flush();
    expect(s.adapter.getText()).toBe('[note saved: fix mp4 · 1 note]');
    expect(s.notes()).toContain(`- fix mp4: ${FFMPEG_BODY}`);
  });

  it('recall: two words bring the command back, body only, ready to run', async () => {
    const s = await setupNotes(`# Notes\n\n- fix mp4: ${FFMPEG_BODY}\n`);
    s.adapter.pushText('note ffmpeg _');
    await flush();
    expect(s.adapter.getText()).toBe(FFMPEG_BODY);
  });

  it('recall preserves prior buffer content (scenario-102 contract)', async () => {
    const s = await setupNotes(`# Notes\n\n- fix mp4: ${FFMPEG_BODY}\n`);
    s.adapter.pushText('here is the repair command.\nnote ffmpeg _');
    await flush();
    expect(s.adapter.getText()).toBe(`here is the repair command.\n${FFMPEG_BODY}`);
  });

  it('tweak: editing INSIDE the recalled fill never wipes it', async () => {
    const s = await setupNotes(`# Notes\n\n- fix mp4: ${FFMPEG_BODY}\n`);
    s.adapter.pushText('note ffmpeg _');
    await flush();
    // User tweaks the input filename in place — the whole point of recall.
    const tweaked = s.adapter.getText().replace('input.mp4', 'workshop.mp4');
    s.adapter.pushText(tweaked);
    await flush();
    expect(s.adapter.getText()).toBe(tweaked);
    expect(s.adapter.getText()).toContain('workshop.mp4');
  });

  it('save confirmation is dismissible: one cycle returns a clean `_`', async () => {
    const s = await setupNotes();
    s.adapter.pushText('note add solo: x _');
    await flush();
    expect(s.adapter.getText()).toBe('[note saved: solo · 1 note]');
    s.hlState.activate(0, s.adapter.getText());
    s.adapter.fireKey('up', { ctrl: true, alt: true });
    expect(s.adapter.getText()).toBe('_');
    // the note itself survives the dismissal — only the confirmation goes
    expect(s.notes()).toContain('- solo: x');
  });

  it('full round-trip: add, then recall from the same session', async () => {
    const s = await setupNotes();
    s.adapter.pushText(`note add fix mp4: ${FFMPEG_BODY} _`);
    await flush();
    s.adapter.pushText('note fix mp4 _');
    await flush();
    expect(s.adapter.getText()).toBe(FFMPEG_BODY);
  });
});

describe('note blank — recall cycling between matches', () => {
  const TWO_ZOOMS = '# Notes\n\n- zoom: https://zoom.us/j/1\n- standup zoom: https://zoom.us/j/2\n';

  it('best match fills first; Ctrl+Alt+Up walks the other matches, then dismisses to _', async () => {
    const s = await setupNotes(TWO_ZOOMS);
    s.adapter.pushText('note zoom _');
    await flush();
    // label-prefix match ("zoom") outranks label-substring ("standup zoom")
    expect(s.adapter.getText()).toBe('https://zoom.us/j/1');

    // Cycling needs the highlight on the filled word (Ctrl+Alt nav in
    // a live host) — same convention as cycling.scenarios.test.ts.
    s.hlState.activate(0, s.adapter.getText());
    s.adapter.fireKey('up', { ctrl: true, alt: true });
    expect(s.adapter.getText()).toBe('https://zoom.us/j/2');

    // dismissible → one more Up returns the untouched `_`
    s.adapter.fireKey('up', { ctrl: true, alt: true });
    expect(s.adapter.getText()).toBe('_');
  });

  it('bare `note _` browses recent entries newest-first (labels kept)', async () => {
    const s = await setupNotes('# Notes\n\n- old: a\n- newer: b\n- newest: c\n');
    s.adapter.pushText('note _');
    await flush();
    expect(s.adapter.getText()).toBe('newest: c');
    s.hlState.activate(0, s.adapter.getText());
    s.adapter.fireKey('up', { ctrl: true, alt: true });
    expect(s.adapter.getText()).toBe('newer: b');
  });
});

describe('note blank — delete', () => {
  it('unique match deletes with visible confirmation; file updated', async () => {
    const s = await setupNotes(`# Notes\n\n- fix mp4: ${FFMPEG_BODY}\n- other: thing\n`);
    s.adapter.pushText('note delete fix mp4 _');
    await flush();
    expect(s.adapter.getText()).toBe('[deleted: fix mp4]');
    expect(s.notes()).not.toContain('ffmpeg');
    expect(s.notes()).toContain('- other: thing');
  });

  it('ambiguous match refuses loudly and destroys nothing — including the typed command', async () => {
    const before = '# Notes\n\n- zoom: a\n- standup zoom: b\n';
    const s = await setupNotes(before);
    s.adapter.pushText('note delete zoom _');
    await flush();
    // [err] results are FEEDBACK: they fill the `_` but keep the user's
    // command intact so the query can be adjusted, not retyped.
    expect(s.adapter.getText()).toBe('note delete zoom [err] 2 notes match "zoom" — be more specific (preview them with `note zoom _`)');
    expect(s.notes()).toBe(before); // never written
  });
});

describe('note blank — guidance and edges', () => {
  it('empty store: bare `note _` nudges toward `note add`', async () => {
    const s = await setupNotes();
    s.adapter.pushText('note _');
    await flush();
    // err feedback keeps the typed keyword (non-destructive contract)
    expect(s.adapter.getText()).toBe('note [err] no notes yet — save one with `note add <text> _`');
  });

  it('recall miss keeps the typed command so the query can be adjusted', async () => {
    const s = await setupNotes('# Notes\n\n- a: b\n');
    s.adapter.pushText('note kubectl _');
    await flush();
    const text = s.adapter.getText();
    expect(text).toContain('no note matches "kubectl"');
    // The command survives the miss — fix "kubectl" and re-fire instead
    // of retyping everything.
    expect(text.startsWith('note kubectl ')).toBe(true);
  });

  it('an earlier unrelated `_` in the buffer is NOT claimed by the note command', async () => {
    // Regression pin for the shape-attach fix (words.indexOf → lastIndexOf):
    // the shape verdict must land on the `_` the shape matched (the note
    // command's own), never an earlier `_` the user left for fluid-blank.
    const s = await setupNotes();
    s.adapter.pushText('fill later _ ok. note add snack _');
    await flush();
    const text = s.adapter.getText();
    expect(text.startsWith('fill later _ ok. ')).toBe(true);   // untouched
    expect(text).toContain('[note saved: snack · 1 note]');
    expect(s.notes()).toContain('- snack');
  });

  it('KNOWN LIMIT: a sentence terminator inside the note body breaks the shape match', async () => {
    // Shapes are sentence-scoped (segment.ts): `. ` splits the command
    // segment, so the `note` keyword no longer leads it and the blank
    // does not fire. Real prose notes hit this. Pinned as a UX finding —
    // v1 ships with it; candidates: quote-aware segmenting or a
    // note-specific shape that spans terminators.
    const s = await setupNotes();
    const text = 'note add remember this. and that _';
    s.adapter.pushText(text);
    await flush();
    expect(s.adapter.getText()).toBe(text); // untouched — fell through
    expect(s.notes()).toBeNull();           // nothing saved
  });
});
