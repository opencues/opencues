---
last_updated: 2026-05-01
---

# Prompt References

This folder contains design notes for the prompts shipped in `defaults/`. **All active prompts live in `.md` config files** — not in code or `.txt` files.

## Where prompts actually live (current state)

| Prompt | File | Section |
|---|---|---|
| Word alternatives (per-domain synonyms) | `cues/<name>/cue.md` (folder-based) or inline `cues.md ## Prompt ### <name>` | one source per file/section, dispatched per-word by `RoutedWordSourceGroup` |
| Keyword-bound blanks (volume, stocks, hn, …) | `blanks/<name>/cue.md` | one folder per blank; matched by `BlankSource` via `blankKeywords` |
| Free-form `_` lookup | `packages/opencues-core/src/sources/fluid-blank-source.ts` | `FluidBlankSource` two-pass (P1 SEGMENT + P3 ANSWER), prompts in TS |
| Spell-check on plain text | `defaults/cues/spelling.md` | regular `ConfigSource` cue (priority 80, `match: .*`) — user-editable like any other word cue |

There are **no hardcoded prompt constants in `ConfigSource`**. ConfigSource instances are driven entirely by `SourceConfig` parsed from `.md` files via `buildSourcesFromConfig()`. `FluidBlankSource` is the only remaining exception — its prompts live in TS because the two-pass pipeline isn't a single-prompt source. Spelling used to be a hardcoded `SpellingSource` class; it was retired in May 2026 once it became clear it duplicated `ConfigSource` with no real specialness.

## Files in this folder

```
prompts/
├── README.md            # This file
├── linked.txt           # Linked words prompt (gender/number agreement)
└── references/          # Prompt design documentation (historical)
    ├── grammar.md       # Word-alternatives + grammar-blank prompts
    ├── factual.md       # Factual-blank answer prompt
    └── math.md          # Math-blank compute prompt
```

## About `references/`

The files in `references/` document the prompts that shipped with the now-removed classifier-routed blank pipeline. They're kept for prompt-design history. Active blank handling lives in `FluidBlankSource` (free-form `_`) and per-blank `cue.md` files (keyword-bound).

## Adding a new domain word source

Create `cues/<name>/cue.md`:

```markdown
---
name: legal
scope: words
priority: 70
match: contract|agreement|clause|indemnify
classify: Legal terminology
---

Your prompt instructions here...
```

`RoutedWordSourceGroup` will pick it up — words matching the `match:` regex route to this source.

## Adding a new keyword-bound blank

Create `blanks/<name>/cue.md` and either a script or a runtime class. See [docs/guides/adding-a-cue-blank.md](../../../docs/guides/adding-a-cue-blank.md) for the four shapes and step-by-step.
