# Chrome Extension — Rendering Approach

## Why CSS Custom Highlight API

We tried three rendering approaches before finding one that works:

### Attempt 1: Overlay div
Positioned a transparent `<div>` with styled `<span>` elements over the target input. Failed due to **font/padding/scroll misalignment** — the overlay never perfectly matched the target's text layout.

### Attempt 2: Inline spans
Wrapped words directly inside the target element's DOM with `<span class="oc-word">`. This gave pixel-perfect alignment since the spans ARE the text. But `innerHTML` assignment **destroys the cursor and selection** on every render. Typing became impossible — cursor jumped to start, keystrokes were eaten, selections lost.

### Attempt 3: Backdrop mirror (for textarea/input)
Created a div behind the textarea with transparent text, matching font/padding/scroll. Same approach as `highlight-within-textarea` and Grammarly. Failed due to **positioning lag** — the mirror never perfectly synced with the input across different pages, CSS layouts, and scroll states.

### Attempt 4: Form input → contenteditable swap
Replaced `<textarea>`/`<input>` with a `contenteditable` div copying all computed styles. Worked partially but **broke page CSS** — the swapped element never matched the original layout exactly, causing visual glitches and form submission issues.

### Attempt 5: CSS Custom Highlight API (current)
The [CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API) applies visual styles to text ranges **without modifying the DOM**. It registers named `Highlight` objects containing `Range` instances, and CSS `::highlight(name)` pseudo-elements style them.

This is the browser equivalent of Claude Code's ANSI escape codes — a separate visual layer that never touches the input text.

**Zero DOM modification.** Cursor, selection, undo history, and typing are never disrupted.

## How It Works

### Registration
```typescript
// Build Range objects for each word that needs highlighting
const dimRanges: Range[] = [];    // words with alternatives
const activeRanges: Range[] = []; // currently selected word
const baseRanges: Range[] = [];   // normal words

// Walk text nodes, create ranges for each word position
const range = new Range();
range.setStart(textNode, startOffset);
range.setEnd(textNode, endOffset);
dimRanges.push(range);

// Register with the browser
CSS.highlights.set('oc-base', new Highlight(...baseRanges));
CSS.highlights.set('oc-dim', new Highlight(...dimRanges));
CSS.highlights.set('oc-active', new Highlight(...activeRanges));
```

### Styling (content.css)
```css
::highlight(oc-dim)    { color: #555 !important; }  /* selectable — darkest */
::highlight(oc-base)   { color: #999 !important; }  /* normal — mid */
::highlight(oc-active)  { color: #fff !important; }  /* active — brightest */
```

### Visual Hierarchy

| Highlight | Color | Purpose |
|-----------|-------|---------|
| `oc-dim` | `#555` (darkest) | Selectable words — has alternatives |
| `oc-base` | `#999` (mid) | Normal words — no alternatives |
| `oc-active` | `#fff` (brightest) | Currently highlighted word |

Selectable words appear darker than normal text, drawing the eye to what can be cycled. The active word pops out in white. Normal words sit in the middle.

## Cycling and Text Changes

When the user cycles a word (Ctrl+Alt+Up/Down), the text changes. This invalidates all Highlight API ranges because the underlying text node is modified. The solution:

1. Modify the text node directly via `textNode.data = newText` (not `textContent` which destroys/recreates nodes)
2. Use `requestAnimationFrame` to rebuild highlights AFTER the text change settles but BEFORE the browser paints

```typescript
// Change text
textNode.data = result.newText;

// Rebuild highlights on next animation frame (before paint)
requestAnimationFrame(() => {
  renderer.render(text, state, engine.words);
});
```

This prevents the "white flash" where all text appears unstyled between the text change and highlight rebuild. The `requestAnimationFrame` ensures highlights are set after the browser processes the text mutation but before it paints to screen.

**Key lesson learned:** Setting highlights synchronously after DOM text changes doesn't work — the browser schedules highlight invalidation asynchronously, so synchronous `highlights.set()` gets overridden. `requestAnimationFrame` defers to the right timing.

### Blank fill (`execCommand`)

The same issue applies when blank auto-populate replaces text via `document.execCommand('insertText')`. This changes the underlying text nodes, invalidating all existing `Range` objects. Highlights set synchronously after `execCommand` are silently discarded — the browser hasn't finished processing the DOM mutation yet.

```typescript
// Replace text in contenteditable
document.execCommand('insertText', false, newText);

// Clear stale highlights immediately (prevents flash of old state)
renderer.clearStyles();

// Rebuild AFTER the DOM settles — synchronous set would be discarded
requestAnimationFrame(() => {
  renderer.render(text, state, engine.words, engine.spans);
});
```

**Rule of thumb:** Any operation that creates or replaces DOM text nodes (`textNode.data`, `execCommand`, `insertAdjacentText`) requires `requestAnimationFrame` before setting new CSS Custom Highlights. Synchronous `highlights.set()` after these operations will be overridden by the browser's internal range invalidation.

## What `::highlight()` Supports

The CSS Custom Highlight API supports a **limited subset** of CSS properties:

| Property | Supported | Notes |
|----------|-----------|-------|
| `color` | Yes | Text color |
| `background-color` | Yes | Background behind text |
| `text-decoration` | Yes | Underline, overline, line-through |
| `text-shadow` | Yes | Shadow effects on text |
| `-webkit-text-stroke` | Yes | Text outline (Chrome) |
| `text-decoration-color` | Yes | Decoration color |
| `text-decoration-style` | Yes | solid, dotted, dashed, wavy |
| `text-decoration-thickness` | Yes | Thickness of decoration line |
| `font-weight` | No | Cannot change weight |
| `font-size` | No | Cannot change size |
| `padding` | No | Cannot add padding |
| `border` | No | Cannot add borders |
| `border-radius` | No | Cannot round corners |
| `opacity` | No | Cannot change opacity |

Essentially: **color, background, text-decoration, and text-shadow** only. No box model properties.

## Supported Elements

| Element Type | Per-Word Coloring | Cycling/Navigation | Notes |
|-------------|-------------------|-------------------|-------|
| `contenteditable` div | Yes (Highlight API) | Yes | Full support |
| `<textarea>` | No | No | Not supported — Highlight API doesn't work on form controls |
| `<input>` | No | No | Not supported — same reason |

The CSS Custom Highlight API only works on DOM text nodes. `<textarea>` and `<input>` render their content internally — it's not part of the DOM tree. There is no reliable way to apply per-word styling to native form controls without replacing them (which breaks page CSS) or using a backdrop mirror (which has positioning/sync issues).

Most modern web apps (Google Docs, Notion, Slack, ChatGPT, VS Code web) use `contenteditable` divs, not native form controls.

## Browser Support

- Chrome 105+ (September 2022)
- Edge 105+
- Safari 17.2+ (partial)
- Firefox 140+ (CSS Custom Highlight API shipped) — see `integrations/firefox/`

## Comparison with Claude Code

| Aspect | Claude Code | Chrome Extension |
|--------|-------------|-----------------|
| Rendering layer | ANSI escape codes in terminal | CSS Custom Highlight API |
| Modifies input? | No (separate render output) | No (Range-based, no DOM change) |
| Cursor disruption | Never | Never (except during cycling — `requestAnimationFrame` timing) |
| Styling options | Full ANSI (color, bold, inverse, underline, dim) | color, background, text-decoration, text-shadow |
| Supports `bold`? | Yes (`\x1b[1m`) | No (not in `::highlight`) |
| Supports `dim`? | Yes (`\x1b[2m`) | Simulated via darker `color` |
| Textarea support | N/A (terminal input) | Not supported |
