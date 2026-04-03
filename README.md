# OpenCues

An open standard for real-time guidance as you type. OpenCues works on top of any text input — LLM prompts, word processors, mobile keyboards — providing alternatives, suggestions, and context before you press enter. Define all behaviour in `.md` config files; integrations bring them to life.

## The Standard

OpenCues is built on three `.md` config files. All prompts, modes, and behaviour live here — not in code.

| File | What it defines | Example |
|------|----------------|---------|
| **cues.md** | Word tips and LLM prompt sources for word alternatives. Each `### section` is a source (grammar, legal, medical, etc.) | `### grammar` with synonym/opposite/creative prompt |
| **blanks.md** | Fill-in-the-blank modes. Each `### section` is a mode with its own prompt and parser. `### classifier` picks which mode to use. | `### math` with `parser: compute` |
| **controls.md** | Cue-controls — words that trigger external scripts instead of text cycling. | `"volume"` runs a volume control script |

Integrations read these files via `cues-core` (the reference implementation in pure TypeScript). To build an integration for a new editor, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Install (Claude Code)

```bash
git clone https://github.com/wkasekende/opencues ~/opencues
~/opencues/integrations/claude-code/patches/setup.sh
export GROQ_API_KEY="your-key"  # add to ~/.bashrc
```

Restart Claude Code. Done.

## Features

| Keys | Action |
|------|--------|
| Ctrl+Alt+Left/Right | Navigate between words |
| Ctrl+Alt+Up/Down | Increment numbers, cycle alternatives |
| Escape | Clear highlight |

### What you get

- **Navigation** — move between words with keyboard
- **Visual cues** — words dim when alternatives are available
- **Alternatives** — cycle through synonyms, opposites, creative suggestions
- **Number cycling** — `42` → `43` → `44`
- **Blanks** — type `_` and get completions (`The capital of France is _` → `Paris`)
- **Cue-controls** — `volume` triggers system volume control
- **Secondary display** — highlighted words show cue-tips

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│                       OpenCues                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  packages/cues-core/          Runtime module                │
│  ├── resolver.ts              CueResolver orchestration     │
│  ├── cues-md.ts               Config parser (cues/blanks.md)│
│  ├── node-http-adapter.ts     HTTPS with keep-alive         │
│  └── sources/                 ConfigSource, parsers...      │
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
- **ConfigSource** — generic config-driven LLM source (one per `###` section in `.md` files)
- **ClassifiedSourceGroup** — wraps blank modes with fast/LLM classification
- **buildSourcesFromConfig** — factory: parses `cues.md` + `blanks.md` → `CueSource[]`
- **NodeHttpAdapter** — HTTPS with connection keep-alive, ~200ms latency to Groq

### integrations/claude-code

Integrates cues-core into Claude Code via [tweakcc](https://github.com/anthropics/tweakcc).

- **patches/setup.sh** — one-command installer
- **patches/wordHighlight.ts** — word navigation, number handling, ANSI rendering
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

See [status line docs](integrations/claude-code/docs/status-line.md) for details.

## Configuration

Settings are in `~/.tweakcc/config.json`:

```json
{
  "misc": {
    "enableWordHighlight": true,
    "enableDynamicHighlight": true,
    "highlightMode": "words",
    "numberDimming": true
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enableWordHighlight` | `true` | Enable Ctrl+Alt+Arrow navigation |
| `enableDynamicHighlight` | `true` | Enable LLM alternatives |
| `highlightMode` | `"words"` | `"numbers"` or `"words"` |
| `numberDimming` | `true` | Dim numbers in gray |
| `highlightExportEnabled` | `true` | Write highlight state JSON for status line |

## Updating

When Claude Code updates:

```bash
cd ~/tweakcc
CLI_JS=$(find ~/.claude -name "cli.js" -path "*claude-code*" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply
```

When OpenCues updates:

```bash
cd ~/opencues && git pull
~/opencues/integrations/claude-code/patches/setup.sh
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
~/opencues/integrations/claude-code/patches/setup.sh
```

### setup.sh fails to patch

tweakcc may have changed. Check for pattern matches:

```bash
grep "MiscSettings" ~/tweakcc/src/types.ts
grep "misc:" ~/tweakcc/src/defaultSettings.ts
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to:
- **Extend the standard** — add new word sources, blank modes, or cue-controls to the `.md` config files
- **Build an integration** — bring OpenCues to a new editor or tool using cues-core
- **Improve cues-core** — modify the core library, run tests, submit changes

New to OpenCues? The [glossary](docs/glossary.md) explains all terminology — cues, blanks, cue-controls, sources, parsers, and more.

## License

Proprietary. All rights reserved. See [LICENSE](LICENSE).
