---
last_updated: 2026-07-04
---

# Response Parser Types

When you add a folder-based `CUE.md` (or a standalone cue-shaped
config), the `parser` field tells `ConfigSource` how to interpret the
LLM's response. There are two:

## 1. alternatives (default)

Extracts per-word alternatives from indexed lines.

**LLM output format:**
```
0:better,improved,enhanced
2:quick,rapid,speedy
```

Each line is `INDEX:alt1,alt2,alt3` where INDEX is the word's position in the input text. The original word is automatically prepended to the alternatives list.

**Use when:** you want multiple word-level suggestions (synonyms, grammar corrections, style variations). This is the default if `parser` is omitted.

## 2. raw

Uses the entire LLM response as a single alternative, with no parsing.

**Use when:** the response doesn't follow a structured format, or you want the full text as-is.

## Quick reference

| Parser | Format | Output | Typical use |
|--------|--------|--------|-------------|
| `alternatives` | `INDEX:alt1,alt2` | Multiple alternatives per word | Word sources, grammar blanks |
| `raw` | (any) | Full response verbatim | Unstructured output |

## Does this apply to BLANK.md?

You can write `parser:` in a folder-based `BLANK.md`'s frontmatter — the
parser accepts it there too, since `CUE.md` and `BLANK.md` share the
same underlying frontmatter shape. But it's only *consumed* by
`ConfigSource` (the class behind LLM-driven word-cues and cue-shaped
sources). A keyword-bound blank (`BlankSource`) gets its value from a
`blankScript` or a runtime class, never from parsing a raw LLM
response — so setting `parser:` on a keyword-bound `BLANK.md` has no
effect. If you're authoring a blank and want response-parsing
behavior, you likely want a source with `scope: blanks` or `scope: all`
instead of a keyword-bound one — see
[`adding-a-cue-blank.md`](adding-a-cue-blank.md).

## Retired: `compute` / `answer`

Earlier versions of this doc listed `compute` (`COMPUTE=40+8`, evaluated
as sanitized JS math) and `answer` (`ANSWER=Paris`, a single verbatim
value) as two more parser types. **Neither exists in the code anymore**
— `BlankParser` is `'alternatives' | 'raw'` only
(`packages/opencues-core/src/cues-md.ts:46`), and `ConfigSource`'s
response switch has no case for either; setting `parser: compute` or
`parser: answer` today silently falls through to `default: return []`
— zero results, not an error.

Math and factual lookups (`4 * 12 = _`, `capital of France is _`) are
handled today by `FluidBlankSource`'s free-form LLM lookup instead of a
rigid `COMPUTE=`/`ANSWER=` format — no per-source config needed, it's
the fallback for any `_` no keyword-bound blank claims. If you're
looking for "how do I make a blank answer a factual question," you
don't need a `parser:` field at all; just don't bind a keyword to it
and let `FluidBlankSource` handle it.
