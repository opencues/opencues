---
last_updated: 2026-04-01
---

# Config Reference (`~/.tweakcc/config.json`)

Complete list of all `settings.misc` config options that gate features. Options with no default listed are `undefined` unless explicitly set.

## Custom Patch Options

These must be explicitly set — they default to `undefined` (off) if missing.

### Word Highlight (required for ALL custom highlight features)

| Option | Type | Default | Required? | Purpose |
|--------|------|---------|-----------|---------|
| `enableWordHighlight` | boolean | undefined | **YES** | Master switch — gates word highlight AND dynamic highlight patches |
| `highlightMode` | `'numbers'\|'words'\|'gender'\|'both'` | `'numbers'` | No | Which words are navigable |
| `highlightColor` | `'white'\|'cyan'\|'yellow'\|'inverse'\|'underline'` | `'white'` | No | Highlight color |
| `numberDimming` | boolean | `true` | No | Dim numbers in dark gray |
| `highlightClearOnEscape` | boolean | `true` | No | Clear highlight on Escape |
| `highlightExportEnabled` | boolean | `true` | No | Export state to JSON file |
| `highlightExportPath` | string | PID-based at runtime | No | Export file path |
| `highlightIndexFromLeft` | boolean | `false` | No | Index direction |
| `highlightWrap` | boolean | `false` | No | Wrap at boundaries |
| `highlightOverridesRainbow` | boolean | undefined | No | Priority over rainbow input |
| `highlightAutoScroll` | boolean | undefined | No | Auto-scroll to highlighted word |
| `highlightClearOnNavigation` | boolean | undefined | No | Clear on cursor navigation |
| `highlightWordPattern` | string | undefined | No | Custom word boundary pattern |
| `actionWordOverrides` | object | undefined | No | Words that trigger external scripts on Up/Down (requires `enableWordHighlight`) |

### Dynamic Highlight (requires `enableWordHighlight: true`)

| Option | Type | Default | Required? | Purpose |
|--------|------|---------|-----------|---------|
| `enableDynamicHighlight` | boolean | `!== false` | No | Enable LLM/tips word analysis (on unless explicitly `false`) |
| `dynamicHighlightDebounceMs` | number | `0` | No | Debounce delay for auto-submit (0 = immediate on space) |

> **Note:** Auto-submit is now always on (no `dynamicHighlightAutoSubmit` toggle). LLM calls go through cues-core's CueResolver and NodeHttpAdapter, not external scripts (no `dynamicHighlightScriptPath`).

### Cursor State Export

| Option | Type | Default | Required? | Purpose |
|--------|------|---------|-----------|---------|
| `enableCursorStateExport` | boolean | undefined | No | Export cursor position to JSON |
| `cursorStateExportPath` | string | `'/tmp/claude-cursor-state.json'` | No | Export file path |

### Rainbow Input

| Option | Type | Default | Required? | Purpose |
|--------|------|---------|-----------|---------|
| `enableRainbowInput` | boolean | undefined | No | Colorize specific words |
| `rainbowInputWords` | string[] | `['wilfred']` | No | Words to rainbow-ize |

## Minimum Config for Full Tips/Cues System

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
- `~/.claude/node_modules/cues-core` (npm package — handles all LLM calls via CueResolver + NodeHttpAdapter)
- `~/.claude/claude-code-tips.json` (tips data)
- `GROQ_API_KEY` env var (for LLM calls)

## Feature Gating

Features have a two-level dependency:

1. **`enableWordHighlight`** — master switch for all highlight features
2. **`enableDynamicHighlight`** — requires `enableWordHighlight: true`

If `enableWordHighlight` is falsy, both word highlight and dynamic highlight are disabled entirely.

> For standard tweakcc options (model customizations, thinking blocks, etc.), see the [tweakcc documentation](https://github.com/anthropics/tweakcc).

## Action Word Overrides Format

```json
{
  "actionWordOverrides": {
    "volume": {
      "action": "volume",
      "upArgs": ["up", "5"],
      "downArgs": ["down", "5"]
    }
  }
}
```

Script path defaults to `~/.claude/actions/{action}.sh`. Override with `"scriptPath": "/path/to/script.sh"`.
