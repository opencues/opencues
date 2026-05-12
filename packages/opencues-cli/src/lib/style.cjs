// Terminal styling helpers. Zero-dep, universal-with-graceful-degradation.
//
// Auto-detection:
//   - Colour: ANSI 16-colour, off on NO_COLOR / non-TTY / TERM=dumb.
//     Set FORCE_COLOR=1 to override (de-facto convention).
//   - Glyphs: UTF-8 if LANG/LC_* contains "utf-?8"; ASCII fallback otherwise.
//     Set OPENCUES_ASCII=1 to force ASCII (useful in legacy Windows cmd.exe).
//   - Hyperlinks (OSC 8): emitted only when colour is enabled; terminals
//     that don't understand OSC 8 silently swallow the escape.

'use strict';

const isTTY = !!process.stdout.isTTY;
const noColor = !!process.env.NO_COLOR || process.env.TERM === 'dumb';
const forced = !!process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0';
const enabled = !noColor && (isTTY || forced);

const utf8 = !process.env.OPENCUES_ASCII && /utf-?8/i.test(
  process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || ''
);

function wrap(open, close) {
  return s => enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);
}

const bold        = wrap(1, 22);
const dim         = wrap(2, 22);
const cyan        = wrap(36, 39);
const green       = wrap(32, 39);
const yellow      = wrap(33, 39);
const red         = wrap(31, 39);
const brightWhite = wrap(97, 39);
// The brand accent — used for the wordmark `_`, the gutter `▎`, and
// other brand surfaces. Currently bright-white for a minimalist look;
// swap this alias to retheme everything at once.
const accent      = brightWhite;

const G = utf8
  ? { check: '🗸', cross: '✗', warn: '⚠', dot: '•', arrow: '→',
      gutter: '▎', treeStart: '│', rule: '─', treeMid: '├─', treeEnd: '└─', treeStem: '│ ',
      missing: '·', prompt: '›' }
  : { check: '+', cross: 'x', warn: '!', dot: '*', arrow: '->',
      gutter: '|', treeStart: '|', rule: '-', treeMid: '+-', treeEnd: '+-', treeStem: '| ',
      missing: '-', prompt: '>' };

function wordmark() {
  return bold('OpenCues') + accent('_');
}

// UTF-8: single glyph (visually punchy). ASCII: bracketed word (more
// scannable when stripped of glyph affordance).
const TAGS_UTF8 = {
  ok:   () => green(bold(G.check)),
  warn: () => yellow(bold(G.warn)),
  err:  () => red(bold(G.cross)),
  info: () => dim(G.dot),
};
const TAGS_ASCII = {
  ok:   () => green('[ok]'),
  warn: () => yellow('[warn]'),
  err:  () => red('[err]'),
  info: () => dim('[..]'),
};
function tag(kind) {
  const set = utf8 ? TAGS_UTF8 : TAGS_ASCII;
  const fn = set[kind];
  return fn ? fn() : `[${kind}]`;
}

function step(n, total, msg) {
  return `${dim(`[${n}/${total}]`)} ${msg}`;
}

function rule(width = 60) {
  return dim(G.rule.repeat(width));
}

// Prepend the accent-coloured gutter mark to each line of a block.
function gutter(linesOrStr) {
  const lines = Array.isArray(linesOrStr) ? linesOrStr : String(linesOrStr).split('\n');
  const g = accent(G.gutter);
  return lines.map(l => `${g} ${l}`).join('\n');
}

// OSC 8 hyperlink. Modern terminals render the text as clickable;
// terminals that don't understand the sequence ignore the escapes and
// show only the text.
function link(text, url) {
  if (!enabled || !url) return text;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

function fileLink(text, absPath) {
  if (!absPath || typeof absPath !== 'string' || !absPath.startsWith('/')) return text;
  return link(text, `file://${absPath}`);
}

// Render rows as a tree under an optional title (gutter + bold).
// Rows are [label, value, marker?]; value/marker default to ''.
function tree({ title, description, rows, labelWidth = null }) {
  const out = [];
  if (title) {
    const head = bold(title) + (description ? '  ' + dim(description) : '');
    out.push(head);
    out.push(dim(G.treeStart));   // dim │ connector linking title → rows
  }
  const width = labelWidth ?? rows.reduce((m, r) => Math.max(m, String(r[0] || '').length), 0);
  for (let i = 0; i < rows.length; i++) {
    const last = i === rows.length - 1;
    const [label, value, marker] = rows[i];
    const branch = dim(last ? G.treeEnd : G.treeMid);
    const lbl = String(label || '').padEnd(width);
    const val = value ?? '';
    const mark = marker ? '  ' + marker : '';
    out.push(`${branch} ${lbl}  ${val}${mark}`);
  }
  return out.join('\n');
}

// Strong banner — plain bold "OpenCues" wordtext beside a reverse-video
// "C_" badge (the compact brand monogram: the C of Cues + the blank `_`).
// Version + tagline trail in dim default text. Falls back to plain when
// styling is off.
function banner({ version, tagline } = {}) {
  if (!enabled) {
    let s = '[C_] OpenCues_'.padEnd(26);
    if (version) s += `  v${version}`;
    if (tagline) s += `  ·  ${tagline}`;
    return s;
  }
  const badge = `\x1b[7m\x1b[1mC_\x1b[22m\x1b[27m`;
  // Visible width of "C_ OpenCues_" is 12 (single-space gap between
  // badge + wordmark). Pad to 26 so the version aligns with the
  // description column of `cmd()` rows (col 29 = 26 + 2-space gap + 1).
  const VISIBLE_NAME_WIDTH = 12;
  const padding = ' '.repeat(26 - VISIBLE_NAME_WIDTH);
  let s = `${badge} ${wordmark()}${padding}`;
  if (version) s += `  v${version}`;
  if (tagline) s += `  ·  ${tagline}`;
  return s;
}

// Existence marker used by `which` / `doctor`-style listings.
function existsMark(exists) {
  if (exists === true)  return green(G.check);
  if (exists === false) return dim(G.missing);
  return '';
}

module.exports = {
  enabled, utf8, bold, dim, cyan, green, yellow, red, brightWhite, accent,
  wordmark, tag, step, rule, gutter, link, fileLink, tree, banner, existsMark,
  G,
};
