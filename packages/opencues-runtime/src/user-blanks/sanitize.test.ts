import { describe, it, expect } from 'vitest';
import { sanitizeBlankOutput } from './sanitize';

// Defensive output sanitizer for user-blank return values. Strips
// HTML-tag-like sequences, zero-width characters, bidi overrides,
// NFKC-normalizes, and caps length at 8KB. Authors can opt out of the
// stripping (not the length cap) via `allowRich: true`. See
// sanitize.ts's header comment for the full threat model.

describe('sanitizeBlankOutput — happy path', () => {
  it('passes plain ASCII text through unchanged', () => {
    expect(sanitizeBlankOutput('hello world')).toBe('hello world');
  });

  it('passes plain unicode text (non-adversarial) through unchanged', () => {
    expect(sanitizeBlankOutput('café ☕ 日本語')).toBe('café ☕ 日本語');
  });

  it('returns "" for null', () => {
    expect(sanitizeBlankOutput(null)).toBe('');
  });

  it('returns "" for undefined', () => {
    expect(sanitizeBlankOutput(undefined)).toBe('');
  });

  it('returns "" for an empty string', () => {
    expect(sanitizeBlankOutput('')).toBe('');
  });

  it('passes a whitespace-only string through unchanged', () => {
    expect(sanitizeBlankOutput('   \t\n  ')).toBe('   \t\n  ');
  });
});

describe('sanitizeBlankOutput — length cap (8KB)', () => {
  it('does not truncate a string of exactly 8192 chars', () => {
    const s = 'a'.repeat(8192);
    const out = sanitizeBlankOutput(s);
    expect(out.length).toBe(8192);
    expect(out).toBe(s);
  });

  it('truncates a string of 8193 chars down to 8192', () => {
    const s = 'a'.repeat(8193);
    const out = sanitizeBlankOutput(s);
    expect(out.length).toBe(8192);
  });

  it('truncates a wildly oversized string (megabytes) to the cap', () => {
    const s = 'x'.repeat(1_000_000);
    const out = sanitizeBlankOutput(s);
    expect(out.length).toBe(8192);
  });

  it('length cap still applies under allowRich', () => {
    const s = '<b>'.repeat(5000); // 15000 chars, all "rich"
    const out = sanitizeBlankOutput(s, { allowRich: true });
    expect(out.length).toBe(8192);
    // Rich mode means the tags themselves survive within the cap.
    expect(out).toContain('<b>');
  });

  it('cap is applied AFTER stripping, not before (stripped chars do not count toward the cap)', () => {
    // 8192 real 'a's plus zero-width junk interleaved — after
    // stripping the zero-width chars, exactly 8192 'a's should
    // remain, unclipped.
    const s = 'a'.repeat(8192).split('').join('​'); // 8192 a's + 8191 ZWSP = 16383 chars
    const out = sanitizeBlankOutput(s);
    expect(out).toBe('a'.repeat(8192));
    expect(out.length).toBe(8192);
  });
});

describe('sanitizeBlankOutput — HTML/tag stripping', () => {
  it('strips a simple tag pair, keeping inner text', () => {
    expect(sanitizeBlankOutput('<b>hi</b>')).toBe('hi');
  });

  it('strips a script tag and its closing tag (does not execute or preserve markup)', () => {
    expect(sanitizeBlankOutput('<script>alert(1)</script>hello')).toBe('alert(1)hello');
  });

  it('strips tags with attributes', () => {
    expect(sanitizeBlankOutput('<a href="https://evil.example">click</a>')).toBe('click');
  });

  it('strips deeply nested tags, keeping only the innermost text', () => {
    expect(sanitizeBlankOutput('<div><span><em>text</em></span></div>')).toBe('text');
  });

  it('leaves an unterminated/malformed tag (no closing ">") untouched', () => {
    // Documents current behaviour: the tag regex requires a closing
    // '>', so a truncated/malformed tag like this is NOT stripped.
    // This is a narrow gap in the defence (an editor that tolerates
    // unterminated markup could still render this), not something
    // this test suite fixes — recorded so a future hardening pass
    // has a concrete repro.
    const s = '<div class="x" onclick=alert(1)';
    expect(sanitizeBlankOutput(s)).toBe(s);
  });

  it('allowRich preserves tags verbatim', () => {
    const s = '<b>bold</b> and <i>italic</i>';
    expect(sanitizeBlankOutput(s, { allowRich: true })).toBe(s);
  });

  it('does not strip a bare "<" or ">" that is not part of a tag-like sequence', () => {
    expect(sanitizeBlankOutput('3 < 5 and 5 > 3')).toBe('3 < 5 and 5 > 3');
  });
});

describe('sanitizeBlankOutput — zero-width character stripping', () => {
  it('strips ZERO WIDTH SPACE (U+200B)', () => {
    expect(sanitizeBlankOutput('hel​lo')).toBe('hello');
  });

  it('strips ZERO WIDTH NON-JOINER (U+200C)', () => {
    expect(sanitizeBlankOutput('hel‌lo')).toBe('hello');
  });

  it('strips ZERO WIDTH JOINER (U+200D)', () => {
    expect(sanitizeBlankOutput('hel‍lo')).toBe('hello');
  });

  it('strips BYTE ORDER MARK / ZERO WIDTH NO-BREAK SPACE (U+FEFF)', () => {
    expect(sanitizeBlankOutput('﻿hello')).toBe('hello');
  });

  it('strips multiple zero-width characters used to hide a payload between visible letters', () => {
    const hidden = 'h​e​l​l​o​ ​w​o​r​l​d';
    expect(sanitizeBlankOutput(hidden)).toBe('hello world');
  });

  it('allowRich preserves zero-width characters (opt-in for ZWJ emoji sequences)', () => {
    const zwjEmoji = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // family emoji via ZWJ
    expect(sanitizeBlankOutput(zwjEmoji, { allowRich: true })).toBe(zwjEmoji);
  });
});

describe('sanitizeBlankOutput — bidi override stripping (obfuscation vector)', () => {
  it('strips RIGHT-TO-LEFT OVERRIDE (U+202E) used to visually flip text direction', () => {
    // Classic phishing trick: a RLO flips the rendering order of the
    // following characters, e.g. making "cod.exe" LOOK like "exe.doc".
    const payload = 'invoice‮exe.cod';
    const out = sanitizeBlankOutput(payload);
    expect(out).toBe('invoiceexe.cod');
    expect(out).not.toMatch(/[‪-‮]/);
  });

  it('strips LEFT-TO-RIGHT OVERRIDE (U+202D)', () => {
    expect(sanitizeBlankOutput('a‭b')).toBe('ab');
  });

  it('strips LEFT-TO-RIGHT EMBEDDING / RIGHT-TO-LEFT EMBEDDING / POP DIRECTIONAL FORMATTING (U+202A-202C)', () => {
    expect(sanitizeBlankOutput('a‪b‫c‬d')).toBe('abcd');
  });

  it('strips directional isolates (U+2066-2069)', () => {
    expect(sanitizeBlankOutput('a⁦b⁧c⁨d⁩e')).toBe('abcde');
  });

  it('allowRich preserves bidi overrides (explicit opt-in, author\'s own responsibility)', () => {
    const payload = 'a‮b';
    expect(sanitizeBlankOutput(payload, { allowRich: true })).toBe(payload);
  });
});

describe('sanitizeBlankOutput — NFKC normalization (homoglyph / compatibility forms)', () => {
  it('normalizes fullwidth Latin letters to standard ASCII', () => {
    // U+FF21 FULLWIDTH LATIN CAPITAL LETTER A, etc. — NFKC collapses
    // these to ordinary 'A'. Used in spoofing to visually mimic a
    // trusted string while sidestepping naive string-equality checks.
    const fullwidth = 'ＡＢＣ'; // "ＡＢＣ"
    expect(sanitizeBlankOutput(fullwidth)).toBe('ABC');
  });

  it('normalizes ligature "ﬁ" (U+FB01) to "fi"', () => {
    expect(sanitizeBlankOutput('ﬁle')).toBe('file');
  });

  it('normalizes superscript digits to plain digits', () => {
    expect(sanitizeBlankOutput('x²')).toBe('x2'); // superscript two
  });

  it('allowRich skips NFKC normalization', () => {
    const fullwidth = 'ＡＢＣ';
    expect(sanitizeBlankOutput(fullwidth, { allowRich: true })).toBe(fullwidth);
  });
});

describe('sanitizeBlankOutput — non-string input coercion', () => {
  it('coerces a number to its string form', () => {
    expect(sanitizeBlankOutput(42)).toBe('42');
  });

  it('coerces a boolean to its string form', () => {
    expect(sanitizeBlankOutput(true)).toBe('true');
    expect(sanitizeBlankOutput(false)).toBe('false');
  });

  it('coerces a plain object via its default toString', () => {
    expect(sanitizeBlankOutput({})).toBe('[object Object]');
  });

  it('coerces an array via its default toString (join with commas)', () => {
    expect(sanitizeBlankOutput([1, 2, 3])).toBe('1,2,3');
  });

  it('coerces 0 to the string "0" (not treated as falsy/empty)', () => {
    expect(sanitizeBlankOutput(0)).toBe('0');
  });

  it('coerces NaN to the string "NaN"', () => {
    expect(sanitizeBlankOutput(NaN)).toBe('NaN');
  });
});

describe('sanitizeBlankOutput — combined adversarial payloads', () => {
  it('strips tags, zero-width, and bidi overrides together in one payload, then normalizes', () => {
    const payload = '<script>​‮evil‬</script>Ａ';
    const out = sanitizeBlankOutput(payload);
    expect(out).toBe('evilA');
  });

  it('adversarial payload combined with an oversized body still respects the length cap', () => {
    const junk = '​'.repeat(100) + 'a'.repeat(9000) + '<div>'.repeat(100);
    const out = sanitizeBlankOutput(junk);
    expect(out.length).toBeLessThanOrEqual(8192);
  });
});
