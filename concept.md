# OpenCues — Core Concept

> The whole system reduces to two ideas. Everything else is implementation.

## Two directions of intent

| Direction | Surface | Trigger | What it is |
|---|---|---|---|
| **LLM → you** | **Cues** (highlights) | plain text | The LLM offers alternatives you didn't ask for |
| **you → system** | **Blanks** (substitutions) | text containing `_` | You explicitly summon a value into a slot |

That's it. Every feature in OpenCues is one of these two things, dressed up.

```
              ┌──────────────────────┐
              │      Plain text      │
              └──────────┬───────────┘
                         │
        LLM → you        ▼
        "here are        Cues  (highlights)
         suggestions"    ├── word-cues (domain synonyms via cues/<name>/CUE.md)
                         └── spelling (typo corrections via cues/spelling.md)


              ┌──────────────────────┐
              │   Text with `_`      │
              └──────────┬───────────┘
                         │
        you → system     ▼
        "fill this       Blanks  (substitutions)
         slot for me"    ├── stateful blanks (volume, hn, stocks…)  ← external state
                         ├── fluid blank      (free-form LLM lookup)
                         └── settings         (opencues _, voice-mode _)
```

## Why the split matters

The two surfaces have **fundamentally different contracts**:

| Property | Cues | Blanks |
|---|---|---|
| User intent | implicit (LLM proposes) | explicit (user summoned) |
| Failure mode | invisible (skip the cycling) | visible (`_` stays unfilled) |
| Latency budget | seconds (you might never look) | sub-second (you're waiting) |
| Determinism | best-effort (LLM judgement) | required (must succeed or fail clearly) |
| External state | none — LLM-only | the entire reason `_` exists |

## What can be built

| You want… | You build… |
|---|---|
| Synonyms for a class of words | a domain cue source: `defaults/cues/<name>/CUE.md` with `match:` regex |
| A new spell-check style cue | a regular `defaults/cues/<name>/CUE.md` with `match: .*` and a custom prompt (same shape as the shipped `defaults/cues/spelling/CUE.md`) |
| External state lookup (API / system / file) | a runtime blank class implementing `Blank` (mirror `StocksBlank`) + BLANK.md with `blankKeywords:` |
| External state via a shell script (native hosts only) | drop a `<name>-blank.sh` next to a BLANK.md with `blankScript:` |
| A pre-baked rotation list | BLANK.md with `blankKeywords:` + `stepValues: [...]` |
| A whole new opt-in cue surface | a `CueSource` + `BuildSourcesOptions` flag + OPENCUES.md toggle |

## Non-extension points (deliberately removed)

- ❌ Word-cycling without `_` — typing "volume" and pressing Up to call a script. **All external state is `_`-gated.**
- ❌ Numeric stepping on plain words ("15.5f" → "16.0f")
- ❌ Catch-everything default word-cues (every cue source must declare `match:` or `keywords:` — no implicit catch-all)
- ❌ Classifier-routed blanks — fluid-blank covers the territory

The shape: **`_` for anything that touches the world. Plain text is LLM-only. Nothing else.**

## Settings (`OPENCUES.md` frontmatter) — every cue surface is opt-in

```yaml
fluid-blank-mode: on          # free-form `_` lookups
word-cues-mode: on            # domain synonym cycling on plain text (per-source match/keywords)
# Spelling: ships as a regular cue at `~/.cues/cues/spelling.md` —
# enabled by default like any other cue. No separate flag.
```

Missing setting → off. Shipped defaults turn all three on; flip to `off` to disable a surface.

