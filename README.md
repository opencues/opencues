# cues-system

LLM-powered word alternatives for Claude Code. Navigate words, increment numbers, flip gender, and cycle through intelligent suggestions.

## Install

```bash
git clone https://github.com/wkasekende/cues-system ~/cues-system
~/cues-system/integrations/claude-code/patches/setup.sh
export GROQ_API_KEY="your-key"  # add to ~/.bashrc
```

Restart Claude Code. Done.

## Features

| Keys | Action |
|------|--------|
| Ctrl+Alt+Left/Right | Navigate between words |
| Ctrl+Alt+Up/Down | Increment numbers, flip gender, cycle alternatives |
| Escape | Clear highlight |

### What you get

- **Word navigation** — jump between words with keyboard
- **Number increment** — `42` → `43` → `44`
- **Gender flip** — `boy` ↔ `girl`, `he` ↔ `she`
- **LLM alternatives** — words dim gray when alternatives available
- **Fill-in-the-blank** — type `_` and get completions (`The capital of France is _` → `Paris`)
- **Action words** — `volume` triggers system volume control
- **Status line tips** — highlighted words show tip text in the status bar

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│                      cues-system                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  packages/cues-core/          Runtime module                │
│  ├── prompts.ts               LLM prompts (GRAMMAR, MATH)   │
│  ├── resolver.ts              CueResolver orchestration     │
│  ├── node-http-adapter.ts     HTTPS with keep-alive         │
│  └── sources/                 GrammarSource, MathSource...  │
│                                                             │
│  integrations/claude-code/patches/       Claude Code integration       │
│  ├── setup.sh                 One-command installer         │
│  ├── wordHighlight.ts         Navigation + rendering        │
│  ├── dynamicHighlight.ts      LLM integration + cycling     │
│  └── cursorStateExport.ts     Cursor position export        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     tweakcc (upstream)                      │
│                                                             │
│  Patch infrastructure — regex-based cli.js modification     │
│  Cloned automatically by setup.sh                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Claude Code                            │
│                                                             │
│  Patched cli.js with:                                       │
│  • Word highlight rendering (ANSI codes)                    │
│  • Keyboard handlers (Ctrl+Alt+Arrow)                       │
│  • LLM call on keystroke (debounced)                        │
│  • require("~/.claude/node_modules/cues-core")              │
└─────────────────────────────────────────────────────────────┘
```

## Requirements

| Requirement | Check |
|-------------|-------|
| Node.js 18+ | `node --version` |
| Claude Code | `which claude` |
| Groq API key | [console.groq.com](https://console.groq.com) |

## Packages

### cues-core

Pure TypeScript module for LLM-based text analysis. No I/O dependencies.

- **CueResolver** — orchestrates multiple sources, merges results
- **GrammarSource** — word alternatives via LLM (synonym, opposite, creative)
- **MathSource** — evaluates math expressions (`4 * 12 = _` → `48`)
- **FactualSource** — answers factual questions (`Capital of France is _` → `Paris`)
- **NodeHttpAdapter** — HTTPS with connection keep-alive, ~200ms latency to Groq

### integrations/claude-code

Integrates cues-core into Claude Code via [tweakcc](https://github.com/anthropics/tweakcc).

- **patches/setup.sh** — one-command installer
- **patches/wordHighlight.ts** — word navigation, number/gender handling, ANSI rendering
- **patches/dynamicHighlight.ts** — LLM integration, alternative cycling, span groups
- **patches/cursorStateExport.ts** — exports cursor position to JSON

Other integrations (VS Code, web, etc.) can be added under `integrations/`.

## Status line (optional)

Shows the highlighted word and its tip in Claude Code's status bar:

```
agents (1/3) - Spawn parallel workers via Task tool
```

**Enable:** Run `/statusline` in Claude Code and set the command to:
```
/home/YOUR_USER/.claude/highlight-statusline.sh
```

**Disable:** Run `/statusline` again and clear the command.

See [status line docs](integrations/claude-code/docs/status-line-integration.md) for details.

## Configuration

Settings are in `~/.tweakcc/config.json`:

```json
{
  "misc": {
    "enableWordHighlight": true,
    "enableDynamicHighlight": true,
    "highlightMode": "numbers",
    "numberDimming": true
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enableWordHighlight` | `true` | Enable Ctrl+Alt+Arrow navigation |
| `enableDynamicHighlight` | `true` | Enable LLM alternatives |
| `highlightMode` | `"numbers"` | `"numbers"`, `"words"`, `"gender"`, or `"both"` |
| `numberDimming` | `true` | Dim numbers in gray |
| `highlightExportEnabled` | `true` | Write highlight state JSON for status line |

## Updating

When Claude Code updates:

```bash
cd ~/tweakcc
CLI_JS=$(find ~/.claude -name "cli.js" -path "*claude-code*" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply
```

When cues-system updates:

```bash
cd ~/cues-system && git pull
~/cues-system/integrations/claude-code/patches/setup.sh
```

## Removing

### Remove patches (restore original Claude Code)

```bash
cp ~/.tweakcc/cli.js.backup $(find ~/.claude -name "cli.js" -path "*claude-code*" | head -1)
```

### Remove supporting files

```bash
rm ~/.claude/claude-code-tips.json
rm ~/.claude/highlight-statusline.sh
rm -rf ~/.claude/node_modules/cues-core
rm -rf ~/.claude/actions
```

### Disable individual features

In `~/.tweakcc/config.json`:

```json
{
  "misc": {
    "enableWordHighlight": false,
    "enableDynamicHighlight": false,
    "highlightExportEnabled": false
  }
}
```

## Troubleshooting

### Words don't turn gray

1. Check API key: `echo $GROQ_API_KEY`
2. Check cues-core: `node -e "require(process.env.HOME+'/.claude/node_modules/cues-core')"`
3. Enable debug: `DEBUG=cues* claude`

### Syntax error after patching

```bash
# Restore original
cp ~/.tweakcc/cli.js.backup $(find ~/.claude -name "cli.js" -path "*claude-code*" | head -1)

# Re-run setup
~/cues-system/integrations/claude-code/patches/setup.sh
```

### setup.sh fails to patch

tweakcc may have changed. Check for pattern matches:

```bash
grep "MiscSettings" ~/tweakcc/src/types.ts
grep "misc:" ~/tweakcc/src/defaultSettings.ts
```

## License

MIT
