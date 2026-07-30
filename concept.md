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

## One way to touch what appears

The two directions produce different things, but once something is **on
screen** you interact with it through a single, uniform model — the same for a
cue's alternatives and a filled blank's value:

- **Gray means "there's more here."** A dimmed span has exactly one meaning:
  it can be cycled or revealed. Nothing else. (A bare blank *keyword* — `volume`
  before its `_` fires — is a pure trigger: no gray, no navigation, no tip. It
  only becomes a gray span once you summon it.)
- **Your cursor reveals it.** Move into (or next to) a gray span and its
  **note** appears inline: the useful thing behind it — a cue's suggestions, a
  passive cue's advisory, a filled blank's tip, a setting's description. Move
  away or edit it and the note vanishes. It is display-only; it is never part
  of what you submit.
- **`_` cycles it.** The same `_` that summons a blank on plain text also
  cycles the gray span your cursor sits on. One key, one act: `_` operates on
  whatever is under you — summon a value on plain text, or step to the next
  alternative on a gray span. (Ctrl+Alt+arrows stay as a power path for precise
  or backward stepping.)

So `_` is the universal verb and gray is the universal noun. Whether the LLM
offered something (a cue) or you summoned it (a blank), you read it the same way
and you cycle it the same way. That symmetry is the point: two directions in,
one interaction out.

## A continuous variant: Auditors

Auditors are the same **LLM → you** direction as Cues, stretched to cover the whole buffer instead of one word at a time. Where a cue proposes alternatives you cycle through, an auditor declares one ongoing concern (grammar, clarity, tone, jargon, ...) and the runtime keeps a rewrite applying itself as you type — shown as dimmed text you can revert, never something you have to accept first. Same direction, same "the system offers, you didn't ask" contract; the difference is scope (whole buffer, not one word) and cadence (continuous, not per-word). See `spec/auditor-spec.md` and `docs/guides/adding-an-auditor.md`.

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

## Settings (`OPENCUES.md` frontmatter) — opt-in per surface

```yaml
word-cues-mode: on            # domain synonym cycling on plain text (per-source match/keywords)
transform-blank-mode: on      # imperative `_` instructions + agent-task lifecycle
# Fluid-blank (free-form `_` lookup) has no toggle — it's the always-on
# base layer every `_` not claimed by a shape falls through to.
# Spelling: ships as a regular cue at `~/.cues/cues/spelling.md` —
# enabled by default like any other cue. No separate flag.
```

Missing setting → off. Shipped defaults turn both real toggles on; flip either to `off` to disable that surface.

