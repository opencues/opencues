// LoadingAnimationBlank — define the blank-loading animation INLINE.
//
//   loading animation _,-,‾,- _                       frames only → custom
//   loading animation _,-,‾,- red,orange,yellow _     frames + colours
//   loading animation ▖,▘,▝,▗ #ff5f5f,#ffd75f 75 _    + interval (ms)
//   loading animation red,blue _                      recolour current animation
//   loading animation 300 _                           interval only
//   loading animation bounce _                        preset (braille-rotate/flipper/off)
//   loading animation show _                          current config summary
//
// Deterministic — no LLM anywhere. The four `blank-loading-*` scalars
// stay the single source of truth: this blank only PARSES the inline
// definition and upserts them into OPENCUES.md frontmatter (via the
// same `rewriteSetting` the `opencues` settings blank uses — one write
// for all touched scalars). The animator reads the scalars through
// live thunks (boot-common), so the next `_` plays the new animation
// after the ~2s hot-reload; no restart, no menu.
//
// Grammar rules the token classifier enforces (see parse()):
//   - Comma-separated lists, NO spaces inside a list. Commas are
//     load-bearing: frames often start with `_`, and a space-separated
//     grammar would fire the blank on the first frame's underscore.
//   - A colour list is a CSV where EVERY item is a colour (ANSI name,
//     0-255 index, or #hex — `isColorItem`, shared with the parsers
//     that read the scalars back).
//   - A bare number is the INTERVAL in ms. A lone 256-colour index is
//     therefore not expressible on its own — write it with a name
//     (`196,red`) or use hex. Documented in BLANK.md.
//   - Anything else with ≥1 item is the frames CSV.
// Every floor is NAMED in the confirmation (truncated frames, clamped
// interval, colour list longer than frames) — never silent.

import type { Blank } from './types';
import {
  ANSI_NAME_TO_HEX,
  CUSTOM_FRAMES_MAX,
  EXTENDED_COLOR_NAMES,
  FRAME_INTERVAL_MAX_MS,
  FRAME_INTERVAL_MIN_MS,
  isColorItem,
  parseFrameIntervalMs,
} from '../modules/blank-loading';
import { rewriteSetting } from './opencues-settings';

const PRESETS = new Set(['bounce', 'braille-rotate', 'flipper', 'off']);
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export interface LoadingAnimationBlankOptions {
  /** Read/write the user's OPENCUES.md (host's opencuesMdIO). */
  readonly readFile: () => Promise<string | null>;
  readonly writeFile: (content: string) => Promise<void>;
}

interface ParsedCommand {
  readonly preset?: string;
  readonly show?: boolean;
  readonly frames?: readonly string[];
  readonly framesTruncated?: number;   // original count when > CUSTOM_FRAMES_MAX
  readonly colors?: readonly string[];
  readonly intervalMs?: number;
  readonly intervalClamped?: boolean;
  readonly error?: string;
}

export class LoadingAnimationBlank implements Blank {
  readonly name = 'loading-animation';
  readonly readOnly = false;
  private readonly _read: () => Promise<string | null>;
  private readonly _write: (content: string) => Promise<void>;

  constructor(opts: LoadingAnimationBlankOptions) {
    this._read = opts.readFile;
    this._write = opts.writeFile;
  }

  async get(_keyword?: string, context?: string[]): Promise<string> {
    const tokens = (context ?? []).map(t => t.trim()).filter(Boolean);
    const cmd = parse(tokens);
    if (cmd.error) return `[err] loading animation: ${cmd.error}`;
    if (cmd.show) return this.show();
    return this.apply(cmd);
  }

  private async show(): Promise<string> {
    const text = (await this._read()) ?? '';
    const get = (name: string): string | undefined => {
      const m = text.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'));
      return m ? m[1].trim() : undefined;
    };
    const mode = get('blank-loading-animation') ?? 'bounce';
    const parts = [mode];
    const frames = get('blank-loading-frames');
    if (mode === 'custom' && frames) parts.push(`frames ${frames}`);
    const rgb = get('blank-loading-colors-rgb');
    const ansi = get('blank-loading-colors-ansi');
    if (rgb) parts.push(`rgb ${rgb}`);
    if (ansi) parts.push(`ansi ${ansi}`);
    parts.push(`${parseFrameIntervalMs(get('blank-loading-interval-ms'))}ms`);
    return parts.join(' · ');
  }

  private async apply(cmd: ParsedCommand): Promise<string> {
    const text = await this._read();
    if (!text) {
      return '[err] loading animation: no OPENCUES.md found — run `opencues seed-configs` first';
    }
    let next = text;
    const summary: string[] = [];
    const notes: string[] = [];

    if (cmd.preset) {
      next = rewriteSetting(next, 'blank-loading-animation', cmd.preset);
      summary.push(cmd.preset);
    }
    if (cmd.frames) {
      next = rewriteSetting(next, 'blank-loading-frames', cmd.frames.join(','));
      // A frame definition IS the intent to run it — flip the mode so
      // the user never hits the "wrote frames but animation is still
      // bounce" dead end.
      next = rewriteSetting(next, 'blank-loading-animation', 'custom');
      summary.unshift('custom', `${cmd.frames.length} frame${cmd.frames.length === 1 ? '' : 's'}`);
      if (cmd.framesTruncated) {
        notes.push(`truncated to ${CUSTOM_FRAMES_MAX} frames (got ${cmd.framesTruncated})`);
      }
    }
    if (cmd.colors) {
      // One user list feeds BOTH parallel scalars: hosts pick rgb or
      // ansi by capability, and each side keeps only the tokens it can
      // render. If one side ends up empty (e.g. hex-only list on a
      // terminal host), that side falls back to its default palette —
      // named in the note so it isn't a silent surprise.
      const rgb: string[] = [];
      const ansi: string[] = [];
      for (const c of cmd.colors) {
        const lc = c.toLowerCase();
        if (HEX_RE.test(lc)) rgb.push(lc);
        else if (/^\d{1,3}$/.test(lc)) ansi.push(lc);
        else if (lc in EXTENDED_COLOR_NAMES) {
          // Everyday name (orange/purple/…): hex for rgb hosts, the
          // 256-colour index for terminal hosts.
          rgb.push(EXTENDED_COLOR_NAMES[lc].hex);
          ansi.push(String(EXTENDED_COLOR_NAMES[lc].ansi256));
        } else {
          ansi.push(lc);
          const hex = ANSI_NAME_TO_HEX[lc];
          if (hex) rgb.push(hex);
        }
      }
      if (rgb.length > 0) next = rewriteSetting(next, 'blank-loading-colors-rgb', rgb.join(','));
      if (ansi.length > 0) next = rewriteSetting(next, 'blank-loading-colors-ansi', ansi.join(','));
      summary.push(`${cmd.colors.length} colour${cmd.colors.length === 1 ? '' : 's'}`);
      if (rgb.length === 0) notes.push('no rgb-capable colours — full-colour hosts use the default palette');
      if (ansi.length === 0) notes.push('no ansi-capable colours — terminal hosts use the default palette');
      if (cmd.frames && cmd.colors.length > cmd.frames.length) {
        notes.push(`${cmd.colors.length - cmd.frames.length} colour(s) beyond the frame count are unused`);
      }
    }
    if (cmd.intervalMs !== undefined) {
      next = rewriteSetting(next, 'blank-loading-interval-ms', String(cmd.intervalMs));
      summary.push(`${cmd.intervalMs}ms`);
      if (cmd.intervalClamped) {
        notes.push(`interval clamped to ${FRAME_INTERVAL_MIN_MS}-${FRAME_INTERVAL_MAX_MS}ms`);
      }
    }

    if (next !== text) await this._write(next);
    const noteStr = notes.length > 0 ? ` (${notes.join('; ')})` : '';
    return `[loading animation: ${summary.join(' · ')}]${noteStr}`;
  }
}

/** Classify the whitespace-separated command tokens. Exported for
 *  direct unit-testing of the grammar. */
export function parse(tokens: readonly string[]): ParsedCommand {
  if (tokens.length === 0) {
    return { error: 'expected frames like `_,-,‾,-`, colours like `red,orange`, an interval in ms, a preset (bounce/braille-rotate/flipper/off), or `show`' };
  }
  if (tokens.length === 1 && (tokens[0] === 'show' || tokens[0] === 'status')) {
    return { show: true };
  }

  let preset: string | undefined;
  let frames: readonly string[] | undefined;
  let framesTruncated: number | undefined;
  let colors: readonly string[] | undefined;
  let intervalMs: number | undefined;
  let intervalClamped: boolean | undefined;

  for (const token of tokens) {
    // Bare number (no comma) = interval. Wins over the 0-255 colour
    // index reading — a lone index isn't expressible; see header.
    if (/^\d+(ms)?$/i.test(token)) {
      if (intervalMs !== undefined) return { error: `two intervals given ("${token}")` };
      const n = parseInt(token, 10);
      intervalClamped = n < FRAME_INTERVAL_MIN_MS || n > FRAME_INTERVAL_MAX_MS;
      intervalMs = Math.min(FRAME_INTERVAL_MAX_MS, Math.max(FRAME_INTERVAL_MIN_MS, n));
      continue;
    }
    const items = token.split(',').map(s => s.trim()).filter(s => s.length > 0);
    if (items.length === 0) return { error: `empty list ("${token}")` };
    if (items.every(isColorItem)) {
      if (colors) return { error: `two colour lists given ("${token}") — one comma-separated list, e.g. red,orange,#22d3ee` };
      colors = items;
      continue;
    }
    // A preset word combines with colours/interval (`bounce 300`), but
    // never with a frame list (frames force `custom`). `show` mixed
    // with anything is a mistake — name it instead of treating the
    // word as a frame glyph.
    if (items.length === 1 && PRESETS.has(items[0].toLowerCase())) {
      if (preset) return { error: `two presets given ("${items[0]}")` };
      preset = items[0].toLowerCase();
      continue;
    }
    if (items.length === 1 && (items[0] === 'show' || items[0] === 'status')) {
      return { error: `"${items[0]}" can't be combined with other tokens` };
    }
    if (frames) return { error: `two frame lists given ("${token}") — one comma-separated list, e.g. _,-,‾,-` };
    if (items.some(i => i.length > 3)) {
      const bad = items.find(i => i.length > 3);
      return { error: `"${bad}" doesn't look like a frame glyph (1-3 chars), a colour, or an interval` };
    }
    if (items.length > CUSTOM_FRAMES_MAX) {
      framesTruncated = items.length;
      frames = items.slice(0, CUSTOM_FRAMES_MAX);
    } else {
      frames = items;
    }
  }

  if (preset && frames) {
    return { error: `"${preset}" can't be combined with a frame list — frames imply the custom animation` };
  }
  if (!preset && !frames && !colors && intervalMs === undefined) {
    return { error: 'nothing to apply — give frames, colours, an interval, or a preset' };
  }
  return { preset, frames, framesTruncated, colors, intervalMs, intervalClamped };
}
