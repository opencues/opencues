/**
 * Tests for the sentinel-mode post-processor.
 *
 * Runs under vitest (or node --test) — uses node:test syntax for
 * portability with the @opencues/core test runner.
 */

import { describe, it, expect } from 'vitest';
import { postProcess } from './post-process';
import { SENTINELS } from './sentinels';

const CATALOG = new Map(SENTINELS.map(s => [s.token, s.value]));

describe('postProcess — verbatim resolution', () => {
  it('resolves a single verbatim token to its value', () => {
    const { output, report } = postProcess('[EMAIL]', { catalog: CATALOG });
    expect(output).toBe('wilfred@example.com');
    expect(report.resolved).toEqual([{ token: '[EMAIL]', value: 'wilfred@example.com' }]);
    expect(report.stripped).toEqual([]);
    expect(report.tolerantMatches).toEqual([]);
  });

  it('resolves multiple tokens in a multi-line answer (signature case)', () => {
    const input = '[FULL NAME]\n[JOB TITLE]\n[COMPANY]\n[EMAIL]';
    const { output, report } = postProcess(input, { catalog: CATALOG });
    expect(output).toBe('Wilfred Kasekende\nSoftware Engineer\nAcme Corp\nwilfred@example.com');
    expect(report.resolved).toHaveLength(4);
  });

  it('leaves non-token text untouched', () => {
    const { output } = postProcess('Hi [FIRST NAME], your invoice is ready.', { catalog: CATALOG });
    expect(output).toBe('Hi Wilfred, your invoice is ready.');
  });
});

describe('postProcess — tolerant matching (Claude format drift)', () => {
  it('recovers [WORK_CITY] underscore form to [WORK CITY] catalog entry', () => {
    const { output, report } = postProcess('[WORK_CITY]', { catalog: CATALOG });
    expect(output).toBe('London');
    expect(report.tolerantMatches).toHaveLength(1);
    expect(report.tolerantMatches[0]).toEqual({
      written: '[WORK_CITY]', canonical: '[WORK CITY]', value: 'London',
    });
    expect(report.stripped).toEqual([]);
    expect(report.resolved).toEqual([]);
  });

  it('recovers extra-spaces form to canonical', () => {
    const { output } = postProcess('[FULL  NAME]', { catalog: CATALOG });
    expect(output).toBe('Wilfred Kasekende');
  });

  it('does NOT tolerantly match lowercase (pattern guard rules it out)', () => {
    // The TOKEN_RE only fires on uppercase + brackets. `[first name]`
    // lowercase isn't even seen as a bracket-token by the post-processor.
    const { output, report } = postProcess('[first name]', { catalog: CATALOG });
    expect(output).toBe('[first name]');
    expect(report.tolerantMatches).toEqual([]);
    expect(report.stripped).toEqual([]);
  });
});

describe('postProcess — hallucination strip', () => {
  it('strips an invented unlisted token (Claude [DATE OF BIRTH])', () => {
    const { output, report } = postProcess('[DATE OF BIRTH]', { catalog: CATALOG });
    expect(output).toBe('');
    expect(report.stripped).toEqual(['[DATE OF BIRTH]']);
  });

  it('strips an invented token but leaves surrounding text', () => {
    const { output } = postProcess('Born on [DATE OF BIRTH] in [HOME CITY].', { catalog: CATALOG });
    expect(output).toBe('Born on  in London.');
  });

  it('mixed: resolves listed, strips unlisted, no leak between', () => {
    const input = '[FIRST NAME] ([NICKNAME]) — [EMAIL]';
    const { output, report } = postProcess(input, { catalog: CATALOG });
    expect(output).toBe('Wilfred () — wilfred@example.com');
    expect(report.resolved.map(r => r.token)).toEqual(['[FIRST NAME]', '[EMAIL]']);
    expect(report.stripped).toEqual(['[NICKNAME]']);
  });
});

describe('postProcess — originalBody preservation', () => {
  it('preserves a catalog token that the user already typed (transform-blank case)', () => {
    // User is writing docs about the sentinel API and types
    // [FIRST NAME] themselves. The LLM is asked to fix grammar; it
    // returns the same bracket-token in its rewrite. The post-processor
    // must NOT substitute it just because the catalog says so —
    // their text wins.
    const body = 'The [FIRST NAME] sentinel resolves to the user\'s first name.';
    const llmOut = 'The [FIRST NAME] sentinel resolves to the user\'s first name.';
    const { output, report } = postProcess(llmOut, { catalog: CATALOG, originalBody: body });
    expect(output).toBe(body);  // unchanged
    expect(report.preserved).toEqual(['[FIRST NAME]']);
    expect(report.resolved).toEqual([]);
  });

  it('preserves a NON-catalog bracket-token the user typed', () => {
    // User types [PLACEHOLDER]. LLM passes it through. Even though it
    // would otherwise be stripped as a hallucination, the body's
    // contents are sacred.
    const body = 'Please fill in [PLACEHOLDER] before sending.';
    const { output, report } = postProcess(body, { catalog: CATALOG, originalBody: body });
    expect(output).toBe(body);
    expect(report.preserved).toEqual(['[PLACEHOLDER]']);
    expect(report.stripped).toEqual([]);
  });

  it('preserves user-typed [WORK_CITY] even if it would tolerant-match', () => {
    // User typed [WORK_CITY] themselves (maybe intentionally, maybe
    // their own placeholder convention). LLM echoes it back. The
    // tolerant matcher would normally resolve it to London — but
    // body-preservation wins because they typed it first.
    const body = 'Use [WORK_CITY] as a fallback variable.';
    const { output, report } = postProcess(body, { catalog: CATALOG, originalBody: body });
    expect(output).toBe(body);
    expect(report.preserved).toEqual(['[WORK_CITY]']);
    expect(report.tolerantMatches).toEqual([]);
  });

  it('substitutes a NEW token even when body has other tokens', () => {
    // Body has [FIRST NAME] (preserved). LLM ADDS a new [EMAIL]
    // (resolved). Mixed-action case.
    const body = 'Hi [FIRST NAME], your invoice is attached.';
    const llmOut = 'Hi [FIRST NAME], your invoice is attached. Reply to [EMAIL].';
    const { output, report } = postProcess(llmOut, { catalog: CATALOG, originalBody: body });
    expect(output).toBe('Hi [FIRST NAME], your invoice is attached. Reply to wilfred@example.com.');
    expect(report.preserved).toEqual(['[FIRST NAME]']);
    expect(report.resolved).toEqual([{ token: '[EMAIL]', value: 'wilfred@example.com' }]);
  });
});

describe('postProcess — no false-positives on prose brackets', () => {
  it('does not touch lowercase `[note]`', () => {
    const { output, report } = postProcess('see [note] above', { catalog: CATALOG });
    expect(output).toBe('see [note] above');
    expect(report.resolved).toEqual([]);
    expect(report.stripped).toEqual([]);
  });

  it('does not touch numeric `[1]` / `[42]` citations', () => {
    const { output } = postProcess('per [1] and [42]', { catalog: CATALOG });
    expect(output).toBe('per [1] and [42]');
  });

  it('does not touch mixed-case prose markers like `[Hello]`', () => {
    const { output } = postProcess('[Hello] there', { catalog: CATALOG });
    expect(output).toBe('[Hello] there');
  });
});

describe('postProcess — empty + degenerate inputs', () => {
  it('empty input returns empty', () => {
    const { output, report } = postProcess('', { catalog: CATALOG });
    expect(output).toBe('');
    expect(report.resolved).toEqual([]);
    expect(report.stripped).toEqual([]);
  });

  it('empty catalog with no tokens returns input unchanged', () => {
    const { output } = postProcess('hello world', { catalog: new Map() });
    expect(output).toBe('hello world');
  });

  it('empty catalog WITH tokens strips them all as hallucinations', () => {
    const { output, report } = postProcess('[FIRST NAME] [EMAIL]', { catalog: new Map() });
    expect(output).toBe(' ');  // both stripped, space between remains
    expect(report.stripped).toEqual(['[FIRST NAME]', '[EMAIL]']);
  });
});
