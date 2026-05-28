import { describe, it, expect } from 'vitest';
import { codeUnitsToCells, cellWidthForCodePoint } from './cell-width';

describe('cellWidthForCodePoint', () => {
  it('ASCII is 1 cell', () => {
    expect(cellWidthForCodePoint(0x20)).toBe(1);
    expect(cellWidthForCodePoint(0x41)).toBe(1);
    expect(cellWidthForCodePoint(0x7E)).toBe(1);
  });
  it('CJK Unified Ideographs are 2 cells', () => {
    expect(cellWidthForCodePoint('日'.codePointAt(0)!)).toBe(2);
    expect(cellWidthForCodePoint('本'.codePointAt(0)!)).toBe(2);
    expect(cellWidthForCodePoint('語'.codePointAt(0)!)).toBe(2);
  });
  it('Hiragana / Katakana are 2 cells', () => {
    expect(cellWidthForCodePoint('に'.codePointAt(0)!)).toBe(2);
    expect(cellWidthForCodePoint('カ'.codePointAt(0)!)).toBe(2);
  });
  it('Hangul syllables are 2 cells', () => {
    expect(cellWidthForCodePoint('한'.codePointAt(0)!)).toBe(2);
  });
  it('Fullwidth ASCII is 2 cells', () => {
    expect(cellWidthForCodePoint('Ａ'.codePointAt(0)!)).toBe(2);
  });
});

describe('codeUnitsToCells', () => {
  it('ASCII: cells = code units', () => {
    expect(codeUnitsToCells('hello', 0)).toBe(0);
    expect(codeUnitsToCells('hello', 3)).toBe(3);
    expect(codeUnitsToCells('hello', 5)).toBe(5);
  });
  it('Japanese: each glyph is 2 cells', () => {
    const text = '日本語に翻訳';
    expect(text.length).toBe(6);
    expect(codeUnitsToCells(text, 0)).toBe(0);
    expect(codeUnitsToCells(text, 1)).toBe(2);
    expect(codeUnitsToCells(text, 3)).toBe(6);
    expect(codeUnitsToCells(text, 6)).toBe(12); // span end of the full string
  });
  it('mixed ASCII + CJK', () => {
    const text = 'hi 日本';
    expect(text.length).toBe(5);
    expect(codeUnitsToCells(text, 0)).toBe(0);
    expect(codeUnitsToCells(text, 2)).toBe(2); // "hi"
    expect(codeUnitsToCells(text, 3)).toBe(3); // "hi "
    expect(codeUnitsToCells(text, 4)).toBe(5); // "hi 日"
    expect(codeUnitsToCells(text, 5)).toBe(7); // "hi 日本"
  });
  it('clamps to text length', () => {
    expect(codeUnitsToCells('日本', 999)).toBe(4);
  });
  it('negative offset → 0', () => {
    expect(codeUnitsToCells('日本', -5)).toBe(0);
  });
  it('supra-BMP code points (e.g. CJK Ext B) — surrogate pair counts as one glyph', () => {
    const text = '𠮷'; // U+20BB7, CJK Ext B
    expect(text.length).toBe(2); // surrogate pair in JS
    expect(codeUnitsToCells(text, 2)).toBe(2); // one wide glyph, 2 cells
  });
  it('emoji are 2 cells (regression guard)', () => {
    // Earth globe (U+1F30D) — 2 code units, 2 cells. Naïve table
    // would say 1, painting the highlight at half-width.
    expect(cellWidthForCodePoint(0x1F30D)).toBe(2);
    expect(cellWidthForCodePoint(0x1F600)).toBe(2); // 😀
    expect(cellWidthForCodePoint(0x1F680)).toBe(2); // 🚀
    expect(cellWidthForCodePoint(0x1F9E0)).toBe(2); // 🧠
    expect(codeUnitsToCells('🌍', 2)).toBe(2);
    expect(codeUnitsToCells('a🌍b', 4)).toBe(4); // 1 + 2 + 1
  });
  it('combining marks contribute 0 cells', () => {
    // "café" with decomposed é (e + combining acute U+0301).
    const decomposed = 'cafe\u0301';
    expect(decomposed.length).toBe(5);
    expect(codeUnitsToCells(decomposed, 5)).toBe(4); // 4 visible glyphs
  });
  it('ZWJ + variation selectors contribute 0 cells', () => {
    expect(cellWidthForCodePoint(0x200D)).toBe(0); // ZWJ
    expect(cellWidthForCodePoint(0xFE0F)).toBe(0); // VS16 (emoji presentation)
    expect(cellWidthForCodePoint(0xFEFF)).toBe(0); // BOM
  });
});
