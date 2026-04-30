---
last_updated: 2026-04-07
---

# Config — Claude Code

Complete list of all `settings.misc` config options that gate features. Options with no default listed are `undefined` unless explicitly set.

## Custom Patch Options

These must be explicitly set — they default to `undefined` (off) if missing.

### Word Highlight (required for ALL custom highlight features)

| Option | Type | Default | Required? | Purpose |
|--------|------|---------|-----------|---------|
| `enableWordHighlight` | boolean | undefined | **YES** | Master switch — gates word highlight AND dynamic highlight patches |
| `highlightMode` | `'numbers'\|'words'` | `'words'` | No | Which words are navigable |
| `highlightColor` | `'white'\|'cyan'\|'yellow'\|'inverse'\|'underline'` | `'white'` | No | Highlight color |
| `numberDimming` | boolean | `true` | No | Dim step-pattern matches and control words in dark gray |
| `highlightClearOnEscape` | boolean | `true` | No | Clear highlight on Escape |
| `highlightExportEnabled` | boolean | `true` | No | Export state to JSON file |
| `highlightExportPath` | string | PID-based at runtime | No | Export file path |
| `highlightIndexFromLeft` | boolean | `false` | No | Index direction |
| `highlightWrap` | boolean | `false` | No | Wrap at boundaries |
| `highlightOverridesRainbow` | boolean | undefined | No | Priority over rainbow input |
| `highlightAutoScroll` | boolean | undefined | No | Auto-scroll to highlighted word |
| `highlightClearOnNavigation` | boolean | undefined | No | Clear on cursor navigation |
| `highlightWordPattern` | string | undefined | No | Custom word boundary pattern |
| `cueControlOverrides` | object | undefined | No | Words that trigger external scripts on Up/Down (requires `enableWordHighlight`) |

### Dynamic Highlight (requires `enableWordHighlight: true`)

| Option | Type | Default | Required? | Purpose |
|--------|------|---------|-----------|---------|
| `enableDynamicHighlight` | boolean | `!== false` | No | Enable LLM/tips word analysis (on unless explicitly `false`) |
| `dynamicHighlightDebounceMs` | number | `0` | No | Debounce delay for auto-submit (0 = immediate on space) |
| `ttsSpeed` | number | `2` | No | SAPI speech rate for TTS (-10 to 10) |
| `ttsScript` | string | `''` | No | Custom TTS script path (overrides SpeakCtl.exe + speak.sh) |

> **Note:** Auto-submit is now always on (no `dynamicHighlightAutoSubmit` toggle). LLM calls go through opencues-core's CueResolver and NodeHttpAdapter, not external scripts (no `dynamicHighlightScriptPath`).

### Text-to-Speech

TTS is per-tip opt-in via the `speak: true` flag on individual tip entries or control configs — not a global toggle. When a user navigates to a word with `speak: true`, the tip text is read aloud.

**Engine priority:** SpeakCtl.exe (~50ms) > PowerShell (~500ms) > espeak-ng > spd-say. SpeakCtl.exe is auto-compiled from `SpeakCtl.cs` by setup.sh on WSL.

**Cancellation:** navigating away or to a different word kills the previous TTS process and cancels any pending speech. 80ms debounce prevents spam during rapid navigation.

### Cursor State Export

| Option | Type | Default | Required? | Purpose |
|--------|------|---------|-----------|---------|
| `enableCursorStateExport` | boolean | undefined | No | Export cursor position to JSON |
| `cursorStateExportPath` | string | `'/tmp/opencues-cursor-state.json'` | No | Export file path |

### Rainbow Input

| Option | Type | Default | Required? | Purpose |
|--------|------|---------|-----------|---------|
| `enableRainbowInput` | boolean | undefined | No | Colorize specific words |
| `rainbowInputWords` | string[] | `['wilfred']` | No | Words to rainbow-ize |

## Minimum Config for Full Tips/OpenCues

```json
{
  "settings": {
    "misc": {
      "enableWordHighlight": true,
      "enableDynamicHighlight": true
    }
  }
}
```

**Also requires at runtime:**
- `~/claude-code-cues/.opencues/core` (npm package — handles all LLM calls via CueResolver + NodeHttpAdapter)
- `~/claude-code-cues/.opencues/tips.json` (tips data)
- `GROQ_API_KEY` env var (for LLM calls)

## Feature Gating

Features have a two-level dependency:

1. **`enableWordHighlight`** — master switch for all highlight features
2. **`enableDynamicHighlight`** — requires `enableWordHighlight: true`

If `enableWordHighlight` is falsy, both word highlight and dynamic highlight are disabled entirely.

> For standard tweakcc options (model customizations, thinking blocks, etc.), see the [tweakcc documentation](https://github.com/anthropics/tweakcc).

## Cue-Blank Overrides Format

```json
{
  "cueControlOverrides": {
    "volume": {
      "control": "volume",
      "tip": "system volume control",
      "speak": true,
      "upArgs": ["up", "5"],
      "downArgs": ["down", "5"]
    }
  }
}
```

Script path defaults to `~/claude-code-cues/.opencues/actions/{control}.sh`. Override with `"scriptPath": "/path/to/script.sh"`.
