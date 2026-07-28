// Shared framebuffer helper for the OpenTUI hosts' inline-cue note (OpenCode +
// shell). OpenTUI's textarea draws its buffer lines contiguously in native
// (Zig/FFI) code with no virtual-text / display-line primitive, so the note
// can't be a real inserted line at the buffer level. Instead each host hooks
// the textarea's `renderAfter` and — after the textarea has drawn normally —
// shifts every rendered row below the span DOWN by one and draws the note in
// the freed row. That yields a real inserted line that pushes text down (like
// Claude Code) without touching the edit buffer (submitted text stays clean).
//
// The row-shift itself is pure typed-array manipulation with NO dependency on
// @opentui/core, so it lives here and both hosts call it — the fiddly part
// can't drift between the two copies, and it's unit-testable with a plain
// mock. Each host still does its own coordinate math and draws the note text
// with its own RGBA colour (that part needs the host's @opentui import).

/** The subset of OpenTUI's `OptimizedBuffer` this helper touches. Typed
 *  structurally so the runtime needn't depend on @opentui/core. */
export interface OpenTuiFrameBuffer {
  readonly width: number;
  readonly height: number;
  readonly buffers: {
    char: Uint32Array;
    fg: Float32Array;
    bg: Float32Array;
    attributes: Uint32Array;
  };
}

/**
 * Shift the already-drawn framebuffer rows `[noteRow, bottom-1]` DOWN by one
 * (so a blank line opens at `noteRow`, pushing existing content down), then
 * clear the freed `noteRow` cells within the textarea's horizontal span
 * `[sx, sx+tw)` so the caller can draw the note there.
 *
 * Operates directly on the exposed cell arrays (`char`/`fg`/`bg`/`attributes`),
 * bottom-up so a source row is never clobbered before it's copied. The fg/bg
 * per-cell stride (RGBA → 4 floats) is derived from the array lengths rather
 * than hard-coded, so it stays correct if OpenTUI ever changes the layout.
 * No-op when the geometry is degenerate.
 */
export function openTuiPushRowsDown(
  buffer: OpenTuiFrameBuffer,
  sx: number,
  tw: number,
  noteRow: number,
  bottom: number,
): void {
  const W = buffer.width;
  const H = buffer.height;
  if (W <= 0 || H <= 0 || tw <= 0) return;
  if (noteRow < 0 || noteRow >= H || bottom < noteRow || bottom >= H) return;
  const bufs = buffer.buffers;
  const cells = W * H;
  if (cells <= 0) return;
  const fgS = Math.max(1, Math.round(bufs.fg.length / cells));
  const bgS = Math.max(1, Math.round(bufs.bg.length / cells));
  for (let y = bottom; y > noteRow; y--) {
    const dst = y * W;
    const src = (y - 1) * W;
    bufs.char.copyWithin(dst, src, src + W);
    bufs.attributes.copyWithin(dst, src, src + W);
    bufs.fg.copyWithin(dst * fgS, src * fgS, (src + W) * fgS);
    bufs.bg.copyWithin(dst * bgS, src * bgS, (src + W) * bgS);
  }
  // Clear the freed note row within the textarea's x-span (the shift left the
  // old first-below-line cells sitting here) so the caller's drawText lands on
  // a clean row.
  const xEnd = Math.min(sx + tw, W);
  for (let x = Math.max(0, sx); x < xEnd; x++) {
    const i = noteRow * W + x;
    bufs.char[i] = 32; // space
    bufs.attributes[i] = 0;
    for (let k = 0; k < fgS; k++) bufs.fg[i * fgS + k] = 0;
    for (let k = 0; k < bgS; k++) bufs.bg[i * bgS + k] = 0;
  }
}
