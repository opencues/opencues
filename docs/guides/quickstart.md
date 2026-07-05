# Quickstart

Get OpenCues running in Claude Code in under 5 minutes.

## 1. Prerequisites

- Node.js 22+ (`node --version`)
- [pnpm](https://pnpm.io/installation) (`corepack enable pnpm` works)
- Claude Code installed (`which claude`)
- A [Cerebras API key](https://cloud.cerebras.ai/platform/) (recommended default — lowest latency free tier; Groq/OpenAI/Anthropic/Gemini/OpenRouter/OpenCode Zen all work too, see [LLM providers](llm-providers.md))

## 2. Install

```bash
# Add your Cerebras key (must be in ~/.bashrc so Claude Code sees it)
echo 'export CEREBRAS_API_KEY="your-key"' >> ~/.bashrc && source ~/.bashrc

# Clone, install workspace deps, build
git clone https://github.com/opencues/opencues ~/opencues
cd ~/opencues
pnpm install
pnpm build

# Install the Claude Code integration
pnpm exec opencues install claude-code
# (alternatives: install opencode, install chrome, install gemini-cli, install --all)
```

Restart Claude Code.

> If your `claude` binary is at a non-standard path (e.g. WSL `claude-cues` at `~/claude-code-cues/`), pass it explicitly: `pnpm exec opencues install claude-code --target ~/claude-code-cues/node_modules/@anthropic-ai/claude-code/cli.js`

## 3. Try it

Type a sentence in Claude Code's input. After ~500ms, words with available alternatives dim gray.

| Keys | Action |
|------|--------|
| **Ctrl+Alt+Left/Right** | Navigate between words |
| **Ctrl+Alt+Up/Down** | Cycle through alternatives |
| **Escape** | Clear highlight |

### Word alternatives

Type `the happy dog` — navigate to `happy`, press Up/Down to cycle through synonyms.

### Fill-in-the-blank

Type `2 + 2 = _` — the `_` auto-fills with `4`.

Type `the capital of France is _` — fills with `Paris`.

### Cue-blanks

Type `volume _` — auto-populates with your system volume. Cycle Up/Down to change it.

## 4. Configure

All behaviour is defined in `.md` config files that hot-reload (~2s, no restart). They live under `.cues/`:

| Path | Purpose |
|------|---------|
| `~/.cues/CUES.md` | Word tips and LLM prompts for alternatives (user-level) |
| `~/.cues/BLANKS.md` | Fill-in-the-blank modes (math, factual, etc.) |
| `~/.cues/blanks/<name>/BLANK.md` | Hardware/API cue-blanks |
| `<project>/.cues/...` | Project-level overrides — wins over user-level on name conflicts |

To populate `~/.cues/` with the repo's defaults: `pnpm exec opencues seed-configs`.
For a fresh project-level config: `cd <project> && pnpm exec opencues init`.

## 5. Inspect

```bash
pnpm exec opencues which                  # every relevant path with ✓ / -
pnpm exec opencues doctor                 # cross-host diagnostics + fix suggestions
pnpm exec opencues list --cues            # all cues across search paths
pnpm exec opencues logs --tail            # tail the runtime debug log
pnpm exec opencues --help                 # full command list
```

## Next steps

- [README](../../README.md) — full feature list and configuration
- [Glossary](../glossary.md) — terminology (cues, blanks, cue-blanks, sources)
- [Feature docs](../features/) — feature concepts explained
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — how to extend OpenCues
