---
last_updated: 2026-04-03
---

# Prompt References

This folder contains reference prompts and documentation. **All active prompts are defined in `.md` config files** — not in code or `.txt` files.

## Where Prompts Live

| Prompt | Config File | Section |
|--------|-------------|---------|
| Word alternatives (synonyms) | `cues.md` | `## Prompt ### grammar` |
| Blank classifier | `blanks.md` | `## Prompt ### classifier` |
| Math blanks | `blanks.md` | `## Prompt ### math` |
| Factual blanks | `blanks.md` | `## Prompt ### factual` |
| Grammar blanks | `blanks.md` | `## Prompt ### grammar` |
| Cue-controls | `controls.md` | `## Controls` |

There are **no hardcoded prompt constants** in opencues-core. `ConfigSource` instances are driven entirely by `SourceConfig` parsed from `.md` files via `buildSourcesFromConfig()`.

## Remaining Files

```
prompts/
├── README.md            # This file
├── linked.txt           # Linked words prompt (gender/number agreement)
├── claude_code.txt      # Legacy — replaced by per-word tips lookup
└── references/          # Prompt design documentation
```

## Adding New Modes

To add a new blank mode (e.g., "code"), add a `### code` subsection to `blanks.md`:

```markdown
### code

\`\`\`yaml
priority: 80
parser: alternatives
match: function|class|import|export|const|let|var
keywords: implement, refactor, debug
\`\`\`

Your prompt text here...
```

To add a new word-alternatives domain (e.g., "legal"), add a `### legal` subsection to `cues.md`:

```markdown
### legal

\`\`\`yaml
match: contract|agreement|clause
priority: 70
\`\`\`

Your prompt text here...
```
