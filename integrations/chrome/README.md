# OpenCues Chrome Extension

LLM-powered word alternatives for `contenteditable` elements in Chrome. Works on Google Docs, Notion, Slack, ChatGPT, and any web app that uses `contenteditable` divs for text input.

## Build

```bash
cd integrations/chrome-extension
npm install
npm run build
```

This produces `dist/` with:
- `content.js` + `content.css` — injected into pages
- `background.js` — service worker (CORS proxy)
- `popup/` — extension popup UI

## Install in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `integrations/chrome-extension` folder (the one with `manifest.json`)
5. The extension icon appears in the toolbar

## Configure

Click the extension icon to open the popup:

| Field | Required | Description |
|-------|----------|-------------|
| **API Key** | Yes | Groq API key (`gsk_...`) for LLM word alternatives |
| **Model** | No | Default: `openai/gpt-oss-120b` (Groq) |
| **API URL** | No | Default: `https://api.groq.com/openai/v1/chat/completions` |
| **Finnhub API Key** | No | For stock price lookups. Free at [finnhub.io](https://finnhub.io) |
| **Target Selector** | Yes | CSS selector for the input element. Default: `[contenteditable="true"]` |
| **cues.md** | No | Paste your cues.md content (word sources, prompts, controls) |
| **blanks.md** | No | Paste your blanks.md content (blank-fill modes) |
| **opencues.md** | No | Paste your opencues.md content (settings, current values) |
| **Tips JSON** | No | Paste your tips JSON (pre-computed word alternatives) |
| **TTS** | No | Enable text-to-speech for cueTips (uses Web Speech API) |
| **Rate** | No | TTS speech rate (1-5, default 2) |

Click **Save**. The extension reloads automatically on the active page.

## Usage

### Target Element

The extension attaches to the first element matching your **Target Selector**. Default is any `contenteditable="true"` div. For a specific element, use an ID selector like `#my-editor`.

If the target doesn't exist when the page loads, the extension watches for it via MutationObserver (works with SPAs that lazy-load editors).

### Word Analysis

As you type, the extension analyzes your text:
- **Instant**: Words matching tips JSON get alternatives immediately (dotted underline)
- **50ms after space**: Completed word sent to LLM for alternatives
- **300ms after pause**: Final word analyzed
- **50ms after edit**: Changed word re-analyzed

Words with alternatives appear **darker** (`#555`), normal words are mid-gray (`#999`), and the active word is **bright white** (`#fff`). This uses the CSS Custom Highlight API — no DOM modification, no cursor disruption.

### Navigation

| Key | Action |
|-----|--------|
| **Ctrl+Alt+Right** | Navigate to next word with alternatives |
| **Ctrl+Alt+Left** | Navigate to previous word with alternatives |
| **Ctrl+Alt+Up** | Cycle to next alternative |
| **Ctrl+Alt+Down** | Cycle to previous alternative |
| **Escape** | Clear highlight |

The highlighted word appears in **bright white**. Linked words (e.g., "boy"↔"his") cycle together.

### Status Bar

When a word is highlighted, a floating status bar appears in the bottom-right corner showing:
- Alternative index (e.g., "2/4")
- cueTip (contextual hint about the word)

### Number Cycling

Numbers matching step patterns (from controls config) cycle arithmetically:
- Ctrl+Alt+Up increments by step amount
- Ctrl+Alt+Down decrements
- Clamped to min/max bounds

### Blank Auto-Populate

Type `_` near a control keyword to trigger auto-populate:

| Example | Control | Result |
|---------|---------|--------|
| `stocks aapl _` | Stocks | `_` → `AAPL: $186.43` |
| `weather London _` | Weather | `_` → `London, GB: 18°C Partly cloudy (12km/h)` |
| `hackernews _` | Hacker News | `_` → top HN title |
| `improve prompt write a poem _` | Prompt Improver | Entire text → 3 improved versions (cycle with Up/Down) |

The prompt improver uses `blankConsumeAll` — it replaces the full text with the first improved version. Cycle through alternatives with Ctrl+Alt+Up/Down. Editing clears the consume-all state.

### Selector/Satellite (opencues.md)

If you paste opencues.md content with settings definitions, selector/satellite word pairs appear in the text. Cycling a selector changes the setting name; cycling a satellite changes the value. Changes are in-memory only (don't persist to opencues.md).

## What to Test

### Basic Flow
1. Open a page with a contenteditable div (or set your target selector)
2. Type a few words and wait ~500ms
3. Words with alternatives should show dotted underlines
4. Press Ctrl+Alt+Right — first navigable word highlights in blue
5. Press Ctrl+Alt+Up — word cycles to next alternative
6. Press Escape — highlight clears
7. Type more — highlight auto-clears on typing

### Linked Words
1. Type "the boy has his dog" and wait for analysis
2. Navigate to "boy" (if it has alts)
3. Cycle Up — "boy" → "girl" and "his" → "her" should update together

### Number Stepping
1. Configure a step pattern in cues.md (e.g., `stepSuffixes: ["%"]`)
2. Type "50%" and navigate to it
3. Ctrl+Alt+Up → "51%" (or whatever step is configured)

### Stock Prices
1. Set Finnhub API key in popup
2. Type "stocks aapl _"
3. Wait ~1 second — `_` should be replaced with "AAPL: $xxx.xx"

### Weather
1. Type "weather London _"
2. Wait ~1 second — `_` replaced with weather info

### Prompt Improver
1. Ensure API key is set
2. Type "improve prompt write a poem _"
3. Wait ~2-3 seconds (two LLM calls)
4. Entire text replaces with first improved prompt
5. Ctrl+Alt+Up/Down cycles through 3 alternatives + original
6. Type anything — consume-all clears, normal editing resumes

### Config Hot-Reload
1. Open popup, change API key or cues.md
2. Click Save
3. Extension should reinitialize on the page without refresh

## Troubleshooting

- **No color changes on text**: The element must be `contenteditable`. Native `<textarea>` and `<input>` elements are not supported (browser limitation — the Highlight API can't style their internal text). Check DevTools console for `[OpenCues]` logs.
- **Ctrl+Alt+Arrow does nothing**: Make sure the contenteditable element has focus. Check console for `[OpenCues] Attaching to` log.
- **Blank not filling**: Check if the keyword is in the control's keyword list (see `controls/index.ts`). Check console for fetch errors.
- **Extension not loading**: Check `chrome://extensions/` for errors. Rebuild with `npm run build`.
- **White flash when cycling**: This can occur briefly as text changes and highlights rebuild. The extension uses `requestAnimationFrame` to minimize this.
- **Wrong word cycling**: If the highlighted word doesn't match what cycles, try navigating away and back. This can happen if the text was edited externally.
