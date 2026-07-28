import { describe, expect, it } from 'vitest';
import { openTuiPushRowsDown, type OpenTuiFrameBuffer } from './opentui-framebuffer';

// Build a tiny mock framebuffer whose `char` cells spell a per-row marker so a
// row shift is trivially observable. fg/bg carry 4 floats per cell (RGBA).
function mockBuffer(width: number, height: number, rowChar: (y: number) => number): OpenTuiFrameBuffer {
  const cells = width * height;
  const char = new Uint32Array(cells);
  const attributes = new Uint32Array(cells);
  const fg = new Float32Array(cells * 4);
  const bg = new Float32Array(cells * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      char[i] = rowChar(y);
      attributes[i] = y; // tag each row so attribute shift is checkable too
      fg[i * 4] = y;      // stamp the fg red channel with the row index
    }
  }
  return { width, height, buffers: { char, fg, bg, attributes } };
}

function rowChars(buf: OpenTuiFrameBuffer, y: number): number[] {
  const { width } = buf;
  return Array.from(buf.buffers.char.subarray(y * width, y * width + width));
}

describe('openTuiPushRowsDown', () => {
  it('shifts rows below the note down by one and clears the freed row', () => {
    // 4 wide, 4 tall. Rows spell: 0→65(A) 1→66(B) 2→67(C) 3→68(D)
    const buf = mockBuffer(4, 4, (y) => 65 + y);
    // Insert the note at row 1 (span on row 0). Rows [1..3] push to [2..4]? No —
    // bottom is the last owned row (3); rows [1,2] shift to [2,3], row 3 (D) falls off.
    openTuiPushRowsDown(buf, 0, 4, 1, 3);
    expect(rowChars(buf, 0)).toEqual([65, 65, 65, 65]); // A — span line, untouched
    expect(rowChars(buf, 1)).toEqual([32, 32, 32, 32]); // freed + cleared (spaces)
    expect(rowChars(buf, 2)).toEqual([66, 66, 66, 66]); // B moved down
    expect(rowChars(buf, 3)).toEqual([67, 67, 67, 67]); // C moved down (D fell off)
  });

  it('shifts fg + attributes in lockstep with char', () => {
    const buf = mockBuffer(3, 3, (y) => 65 + y);
    openTuiPushRowsDown(buf, 0, 3, 1, 2);
    // row 2 should now carry row 1's attribute tag (1) and fg red (1)
    expect(buf.buffers.attributes[2 * 3]).toBe(1);
    expect(buf.buffers.fg[2 * 3 * 4]).toBe(1);
    // freed row 1 cleared
    expect(buf.buffers.attributes[1 * 3]).toBe(0);
    expect(buf.buffers.fg[1 * 3 * 4]).toBe(0);
  });

  it('only clears within the textarea x-span [sx, sx+tw)', () => {
    const buf = mockBuffer(6, 3, (y) => 65 + y);
    // textarea occupies columns [2,5); clear only those on the note row
    openTuiPushRowsDown(buf, 2, 3, 1, 2);
    const row1 = rowChars(buf, 1);
    expect(row1.slice(0, 2)).toEqual([66, 66]); // cols 0-1 untouched (still B)
    expect(row1.slice(2, 5)).toEqual([32, 32, 32]); // cols 2-4 cleared
    expect(row1[5]).toBe(66); // col 5 untouched
  });

  it('no-op on degenerate geometry (does not throw, leaves buffer intact)', () => {
    const buf = mockBuffer(4, 4, (y) => 65 + y);
    const before = Array.from(buf.buffers.char);
    openTuiPushRowsDown(buf, 0, 0, 1, 3);   // tw = 0
    openTuiPushRowsDown(buf, 0, 4, -1, 3);  // noteRow < 0
    openTuiPushRowsDown(buf, 0, 4, 5, 6);   // noteRow >= height
    expect(Array.from(buf.buffers.char)).toEqual(before);
  });
});
