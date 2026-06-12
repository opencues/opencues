# Max Thinking (`max-thinking`)

Trade reasoning depth for speed. Reasoning-capable models (Groq /
Cerebras / OpenAI gpt-oss + gpt-5 families) can "think" before they
answer — better quality, but slower and more expensive. `max-thinking`
is one knob that decides whether each model thinks as hard as it's
allowed to, or drops to a faster, lighter level.

```
# ~/.cues/OPENCUES.md
max-thinking: on    # default — each model reasons up to its ceiling
max-thinking: off   # faster + cheaper — each model thinks minimally
```

Every verified model has a bench-tuned **ceiling** (the most it should
ever think) and a reduced **off** level:

| Provider / model            | ceiling (`on`) | reduced (`off`) |
|-----------------------------|----------------|-----------------|
| Cerebras gpt-oss-120b       | medium         | low             |
| Cerebras zai-glm-4.7        | medium         | low             |
| Groq gpt-oss-120b / 20b     | low            | none            |
| OpenAI gpt-5.4 / mini / nano| low            | none            |
| OpenRouter gpt-oss          | low            | none            |
| OpenCode Zen free pool      | low            | none            |
| Anthropic / Gemini          | (no reasoning — `max-thinking` has no effect) | |

`on` is the default and reproduces the behaviour OpenCues has always
had — each model already used its ceiling. `off` is the opt-in "go
faster" mode: cerebras drops from medium → low, the gpt-oss / gpt-5
family drops from low → none (reasoning fully disabled).

## What it affects

`max-thinking` applies to every prose/lookup LLM surface:

- **word-cues** (alternatives on plain words)
- **sentence-cues** (`scope: sentence` rewrites)
- **fluid-blank** (`capital of france _`)
- **transform-blank** (`make this formal _`)
- **agent-rewrite** (background agentic rewrites — reads the auditors bucket)

The **fluid-config classifier** (`stop showing tips _`) is *not*
affected — it always reasons at `low` because its output is tiny and
must be deterministic.

Non-reasoning providers (Anthropic, Gemini) ignore the setting entirely
— they have no `reasoning_effort` knob.

## How to set it

Three ways, all equivalent:

1. **Edit the file**: set `max-thinking: off` in `~/.cues/OPENCUES.md`.
   Hot-reloads within ~2s on the next keystroke.
2. **Cycle the menu**: `opencues settings _` → cycle to `max-thinking`
   → Ctrl+Alt+↑/↓ between `on` / `off`.
3. **Natural language** (`fluid-config-mode: on`): type something like
   `think less _` or `turn off max thinking _` and the config-intent
   classifier routes it to `max-thinking: off`.

## Interaction with `with <model>` overrides

A per-call `with <model>` override (see [model-override.md](model-override.md))
swaps the model for one call; `max-thinking` still applies to that call
using the override model's ceiling. An explicit reasoning floor set by a
source (fluid-blank pins `low` internally) always wins, but is clamped
down to the model's ceiling — `max-thinking` is a true cap.

## Reference

Implementation + the per-model ceiling table live in
`packages/opencues-core/src/model-thinking.ts`. Canonical design notes:
[docs/architecture/max-thinking.md](../architecture/max-thinking.md).
