# Quickstart

Get OpenCues running in Claude Code in under 5 minutes.

## 1. Prerequisites

- Node.js 18+ (`node --version`)
- Claude Code installed (`which claude`)
- A free [Groq API key](https://console.groq.com)

## 2. Install

```bash
# Add your Groq key (must be in ~/.bashrc so Claude Code sees it)
echo 'export GROQ_API_KEY="your-key"' >> ~/.bashrc && source ~/.bashrc

# Clone and install
git clone https://github.com/opencues/opencues ~/opencues
~/opencues/integrations/claude-code/patches/setup.sh
```

Restart Claude Code.

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

### Controls

Type `volume _` — auto-populates with your system volume. Cycle Up/Down to change it.

## 4. Configure

All behaviour is defined in `.md` config files that hot-reload (~2s, no restart):

| File | Purpose |
|------|---------|
| `cues.md` | Word tips and LLM prompts for alternatives |
| `blanks.md` | Fill-in-the-blank modes (math, factual, etc.) |
| `controls/{name}/cue.md` | Hardware/API controls |

Edit any of these and the changes take effect on the next keystroke.

## Next steps

- [README](../../README.md) — full feature list and configuration
- [Glossary](../glossary.md) — terminology (cues, blanks, controls, sources)
- [Feature docs](../features/) — 18 feature concepts explained
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — how to extend OpenCues
