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
         suggestions"    ├── word-alts (domain synonyms via cues/<name>/cue.md)
                         └── spelling (typo corrections via SpellingSource)


              ┌──────────────────────┐
              │   Text with `_`      │
              └──────────┬───────────┘
                         │
        you → system     ▼
        "fill this       Blanks  (substitutions)
         slot for me"    ├── control blanks (volume, hn, stocks…)  ← external state
                         ├── fluid blank   (free-form LLM lookup)
                         └── settings      (opencues _, voice-mode _)
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
| Synonyms for a class of words | a domain cue source: `defaults/cues/<name>/cue.md` with `match:` regex |
| A new spell-check style cue | a TS class implementing `CueSource` (mirror `SpellingSource`) |
| External state lookup (API / system / file) | a runtime blank class implementing `Blank` (mirror `StocksControl`*) + cue.md with `blankKeywords:` |
| External state via a shell script (native hosts only) | drop a `<name>-blank.sh` next to a cue.md with `blankScript:` |
| A pre-baked rotation list | cue.md with `blankKeywords:` + `stepValues: [...]` |
| A whole new opt-in cue surface | a `CueSource` + `BuildSourcesOptions` flag + opencues.md toggle |

\* class names still say `*Control` — see Open Simplifications below.

## Non-extension points (deliberately removed)

- ❌ Word-cycling without `_` — typing "volume" and pressing Up to call a script. **All external state is `_`-gated.**
- ❌ Numeric stepping on plain words ("15.5f" → "16.0f")
- ❌ Default catch-everything word-alts (off by default — opt in via `default-word-alts: on`)
- ❌ Classifier-routed blanks — fluid-blank covers the territory (off by default)

The shape: **`_` for anything that touches the world. Plain text is LLM-only. Nothing else.**

## Settings (`opencues.md`) — every cue surface is opt-in

```yaml
fluid-blank-mode: on          # free-form `_` lookups
spelling-mode: on             # spell-check on plain text
word-alts-mode: on            # domain synonym cycling on plain text
default-word-alts: off        # don't colour every word
classified-blanks-mode: off   # legacy classifier — fluid covers it
```

Missing setting → off. Every surface defaults off. The user opts in to what they want.

## Open simplifications (residual misalignment)

These predate the concept-cleanup pass; the names disagree with the dual-direction model and could be aligned in follow-up commits:

1. **Class names `*Control` → `*Blank`** — runtime classes (`StocksControl`, `WeatherControl`, `HackerNewsControl`, `PromptImproverControl`, `AnswerControl`, `OpenCuesSettingsControl`, `CountriesControl`, `CryptoControl`, `DictionaryControl`) implement the `Blank` interface but are still named `*Control`. Pure rename; safe.
2. **`controlsRegistry` → `blanksRegistry`** — the runtime registry is still called `controlsRegistry`. Pure rename; safe.
3. **`metadata.controlName` → `metadata.blankName`** — CueResult metadata key used as a cross-module lock identifier. Mechanical but touches ~30 sites; check no string comparison hardcodes the literal `"controlName"` outside the rename target.
4. **cue.md frontmatter `type: control`, `control: <name>`** — user-authored config files still use the legacy field names. Either:
   - Drop both (the dirname under `defaults/blanks/<name>/` already names the blank), or
   - Rename to `type: blank` + `name: <name>` with parser-side back-compat.
5. **Wire format: `'control-invoke'` JSON-RPC method, `"controlName"` JSON key** — preserved to avoid breaking the Codex Rust bridge. Renaming = protocol bump. Cosmetic value only; not recommended unless we're already shipping a Codex protocol bump for another reason.
6. **`BlankValuesCache` constructor parameters** — threaded through `Cycling` and `Statusline` constructors but unused after the word-cycling removal. Either drop the parameter (touches adapter-band wiring) or delete the cache class entirely if no remaining caller exercises it.

Items 1, 2, 3 are pure cleanup with no migration cost. Items 4–6 trade naming clarity for migration / protocol break.
