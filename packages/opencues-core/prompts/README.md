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
| Spell-check on plain text | `packages/opencues-core/src/sources/spelling-source.ts` | `SpellingSource`, prompt in TS |
| Legacy classifier blank modes (math/factual/translation/…) | `blanks.md ## Prompt ### <mode>` | dormant — opt in via `classified-blanks-mode: on` in `opencues.md` |

There are **no hardcoded prompt constants in `ConfigSource`**. ConfigSource instances are driven entirely by `SourceConfig` parsed from `.md` files via `buildSourcesFromConfig()`. `FluidBlankSource` and `SpellingSource` are the exceptions — their prompts live in TS because they're not user-customisable per-source.

## Files in this folder

```
prompts/
├── README.md            # This file
├── linked.txt           # Linked words prompt (gender/number agreement)
└── references/          # Prompt design documentation (LEGACY — see below)
    ├── classifier.md    # Classifier routing prompt
    ├── grammar.md       # Word-alternatives + grammar-blank prompts
    ├── factual.md       # Factual-blank answer prompt
    └── math.md          # Math-blank compute prompt
```

## About `references/` (legacy)

The four files in `references/` document the prompts the legacy classifier-routed blank pipeline ships with. That pipeline (`ClassifiedSourceGroup`) is **off by default** — `fluid-blank-mode: on` covers most blank-fill ground without the routing LLM call. Read these references only if you opt into the classifier (`classified-blanks-mode: on`) or are studying the prompt-design history.

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
