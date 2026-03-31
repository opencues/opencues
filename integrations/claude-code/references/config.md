---
last_updated: 2026-03-31
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

## Standard tweakcc Options

These are standard tweakcc options, not custom patches. Included for completeness.

| Option | Type | Default | Purpose |
|--------|------|---------|---------|
| `showTweakccVersion` | boolean | `true` | Show version in status |
| `showPatchesApplied` | boolean | `true` | Show applied patches count |
| `enableModelCustomizations` | boolean | `true` | Access all Claude models with /model |
| `expandThinkingBlocks` | boolean | `true` | Show thinking blocks without Ctrl+O |
| `hideStartupBanner` | boolean | `false` | Hide startup banner |
| `hideCtrlGToEdit` | boolean | `false` | Hide "Ctrl+G to edit" message |
| `hideStartupClawd` | boolean | `false` | Hide startup clawd |
| `increaseFileReadLimit` | boolean | `false` | Increase file read limit |
| `suppressLineNumbers` | boolean | `false` | Suppress line numbers |
| `suppressRateLimitOptions` | boolean | `false` | Suppress rate limit options |
| `tokenCountRounding` | number\|null | `null` | Round token counts |
| `enableRememberSkill` | boolean | `false` | Enable /remember skill |
| `autoAcceptPlanMode` | boolean | `false` | Auto-accept plan mode |
| `allowBypassPermissionsInSudo` | boolean | `false` | Bypass permissions in sudo |
| `suppressNativeInstallerWarning` | boolean | `false` | Suppress native installer warning |
| `filterScrollEscapeSequences` | boolean | `false` | Filter scroll escape sequences |
| `allowCustomAgentModels` | boolean | `false` | Custom agent models |
| `enableWorktreeMode` | boolean | `true` | Worktree mode |
| `enableSessionMemory` | boolean | `true` | Session memory |
| `mcpConnectionNonBlocking` | boolean | `true` | MCP non-blocking connections |
| `mcpServerBatchSize` | number\|null | `null` | MCP batch size |
| `statuslineThrottleMs` | number\|null | `null` | Status line throttle |
| `statuslineUseFixedInterval` | boolean | `false` | Fixed interval for status line |
| `enableContextLimitOverride` | boolean | `false` | Override context limit |
| `enableConversationTitle` | boolean | `true` | Conversation titles |
| `enableVoiceMode` | boolean | `false` | Voice mode |
| `enableVoiceConciseOutput` | boolean | `true` | Concise voice output |
| `enableSwarmMode` | boolean | undefined | Swarm mode |
| `tableFormat` | string | `'default'` | Table format style |

## Gating Logic

The custom patches have a two-level gate in `index.ts:638-659`:

```typescript
// Level 1: Word highlight (numbers, gender, navigation)
const highlightConfig = config.settings.misc?.enableWordHighlight ? {...} : null;

// Level 2: Dynamic highlight (tips, LLM, action words)
// Requires BOTH enableDynamicHighlight AND enableWordHighlight
const dynamicConfig = (enableDynamic && config.settings.misc?.enableWordHighlight) ? {...} : null;
```

If `enableWordHighlight` is falsy (undefined, false, null), **BOTH** word highlight and dynamic highlight patches are skipped entirely. No error is logged.

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
