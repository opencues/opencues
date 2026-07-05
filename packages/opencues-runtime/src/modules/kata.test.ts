// Unit tests for the kata module's pure functions. The multi-step
// journey (start → coach tick → done → stop) is pinned end-to-end by the
// agentic scenario 42-kata-mode.json — these cover parsing + phrase
// detection, the pieces that don't need a live host.

import { describe, it, expect } from 'vitest';
import { parseKataMd, matchControlPhrase, parseCoachResponse, parseCoachMarkup } from './kata';

const SAMPLE = `---
name: claude-code-basics
id: 1
title: Claude Code basics
---

Intro prose.

## Step 1 — enter plan mode
Press Shift+Tab twice, then type done.
coach:
  - Nothing typed → tell them Shift+Tab twice

## Step 2 — ask for a plan
Ask Claude to write a PLAN.
`;

describe('parseKataMd', () => {
  it('parses frontmatter + steps', () => {
    const doc = parseKataMd(SAMPLE, 'fallback');
    expect(doc).not.toBeNull();
    expect(doc!.name).toBe('claude-code-basics');
    expect(doc!.id).toBe('1');
    expect(doc!.title).toBe('Claude Code basics');
    expect(doc!.steps).toHaveLength(2);
    expect(doc!.steps[0].title).toBe('Step 1 — enter plan mode');
    expect(doc!.steps[0].body).toContain('coach:');
    expect(doc!.steps[1].title).toBe('Step 2 — ask for a plan');
  });

  it('falls back to folder name without frontmatter', () => {
    const doc = parseKataMd('## Step 1\ndo a thing\n', 'my-folder');
    expect(doc!.name).toBe('my-folder');
    expect(doc!.steps).toHaveLength(1);
  });

  it('returns null when no steps', () => {
    expect(parseKataMd('---\nname: x\n---\njust prose', 'x')).toBeNull();
  });

  it('strips leading # from id', () => {
    const doc = parseKataMd('---\nid: #01\n---\n## Step 1\nbody', 'x');
    expect(doc!.id).toBe('01');
  });
});

describe('matchControlPhrase', () => {
  it('matches start with id arg', () => {
    const m = matchControlPhrase('start kata 1 _', false);
    expect(m).toEqual({ kind: 'start', arg: '1', phraseStart: 0, fresh: false });
  });

  it('matches start with #NN and name args', () => {
    // `#` prefix is consumed by the trigger regex; the arg comes back bare.
    expect(matchControlPhrase('start kata #01 _', false))
      .toMatchObject({ kind: 'start', arg: '01' });
    expect(matchControlPhrase('start kata claude-code-basics _', false))
      .toMatchObject({ kind: 'start', arg: 'claude-code-basics' });
  });

  it('restart kata N _ requests a fresh start (ignores saved progress)', () => {
    expect(matchControlPhrase('restart kata 1 _', false))
      .toMatchObject({ kind: 'start', arg: '1', fresh: true });
    expect(matchControlPhrase('start kata 1 _', false))
      .toMatchObject({ kind: 'start', fresh: false });
  });

  it('matches bare start (no arg)', () => {
    expect(matchControlPhrase('start kata _', false))
      .toMatchObject({ kind: 'start', arg: null });
  });

  it('phrase must lead the sentence containing _', () => {
    // Mid-sentence mention does NOT trigger.
    expect(matchControlPhrase('I want to start kata 1 _', false)).toBeNull();
    // New sentence after prior content DOES, and phraseStart preserves the prior span.
    const m = matchControlPhrase('hii world. start kata 1 _', false);
    expect(m).toMatchObject({ kind: 'start', arg: '1' });
    expect(m!.phraseStart).toBe('hii world. '.length);
  });

  it('done/next/skip only match while active', () => {
    expect(matchControlPhrase('done _', false)).toBeNull();
    expect(matchControlPhrase('done _', true)).toMatchObject({ kind: 'advance', word: 'done' });
    expect(matchControlPhrase('skip _', true)).toMatchObject({ kind: 'advance', word: 'skip' });
  });

  it('advance words fire trailing after other text (live-reported: appended skip _ was dead)', () => {
    const m = matchControlPhrase('git checkout main skip _', true);
    expect(m).toMatchObject({ kind: 'advance', word: 'skip' });
    // Consume preserves the prior text: phraseStart points at "skip".
    expect(m!.phraseStart).toBe('git checkout main '.length);
    // Mid-WORD must not fire ("whiskip _" is not a command).
    expect(matchControlPhrase('whiskip _', true)).toBeNull();
    // And still inert while no kata runs.
    expect(matchControlPhrase('git checkout main skip _', false)).toBeNull();
  });

  it('requires the trailing _', () => {
    expect(matchControlPhrase('start kata 1', false)).toBeNull();
    expect(matchControlPhrase('done', true)).toBeNull();
  });

  it('matches stop regardless of arg-less form', () => {
    expect(matchControlPhrase('stop kata _', true)).toMatchObject({ kind: 'stop' });
  });
});

describe('parseCoachResponse', () => {
  it('parses the three-line format', () => {
    const v = parseCoachResponse('STEP: 2\nSTATUS: STEP_DONE\nCOACH: Nice — next step.');
    expect(v).toEqual({ step: 2, status: 'STEP_DONE', coach: 'Nice — next step.', control: null });
  });

  it('tolerates surrounding prose and case drift', () => {
    const v = parseCoachResponse('Sure!\nstep: 3\nstatus: in_progress\ncoach: Press Enter.\nThanks!');
    expect(v).toMatchObject({ step: 3, status: 'IN_PROGRESS', coach: 'Press Enter.' });
  });

  it('returns null when STATUS or COACH missing', () => {
    expect(parseCoachResponse('STEP: 1\nCOACH: hi')).toBeNull();
    expect(parseCoachResponse('STEP: 1\nSTATUS: IN_PROGRESS')).toBeNull();
    expect(parseCoachResponse('garbage')).toBeNull();
  });

  it('missing STEP is tolerated (null)', () => {
    const v = parseCoachResponse('STATUS: OFF_TRACK\nCOACH: fix it');
    expect(v).toMatchObject({ step: null, status: 'OFF_TRACK' });
  });

  it('parses the optional CONTROL: STOP line', () => {
    const v = parseCoachResponse('STEP: 2\nSTATUS: IN_PROGRESS\nCOACH: Bye!\nCONTROL: STOP');
    expect(v).toMatchObject({ control: 'STOP' });
    const noCtl = parseCoachResponse('STEP: 2\nSTATUS: IN_PROGRESS\nCOACH: keep going');
    expect(noCtl).toMatchObject({ control: null });
    // Only STOP is a recognised control — anything else is ignored.
    const junk = parseCoachResponse('STATUS: IN_PROGRESS\nCOACH: hi\nCONTROL: ADVANCE');
    expect(junk).toMatchObject({ control: null });
  });
});

describe('parseCoachMarkup', () => {
  it('splits prose and command spans', () => {
    const r = parseCoachMarkup('type `next _` when done · `Esc ×3` exits');
    expect(r.plain).toBe('type next _ when done · Esc ×3 exits');
    expect(r.segments).toEqual([
      { text: 'type ', command: false },
      { text: 'next _', command: true },
      { text: ' when done · ', command: false },
      { text: 'Esc ×3', command: true },
      { text: ' exits', command: false },
    ]);
  });

  it('no markup → one prose segment', () => {
    const r = parseCoachMarkup('just keep going');
    expect(r.segments).toEqual([{ text: 'just keep going', command: false }]);
  });

  it('unbalanced backtick degrades to plain text', () => {
    const r = parseCoachMarkup('type `broken');
    expect(r.plain).toBe('type `broken');
    expect(r.segments.every(s => !s.command)).toBe(true);
  });
});
