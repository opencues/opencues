---
last_updated: 2026-05-01
---

# Fill-in-the-Blank

Typing `_` (underscore) creates a blank that the system fills contextually. Blanks reverse the direction of regular cues — instead of the LLM offering you alternatives, you're explicitly summoning a value.

---

## Dispatch order

Every `_` slot routes through the same priority chain:

1. **`BlankSource` (priority 95)** — keyword-bound. If any registered blank's `blankKeywords` matches a phrase within `blankProximity` words of the `_`, that blank claims the slot. Auto-populates with the blank's current value (script `get` or runtime-class `blankInvoke`). Up/Down cycling writes back. Examples: `volume _` → `50%`, `nvda _` → `$209.25`, `define ephemeral _` → `lasting briefly`.

2. **`FluidBlankSource` (priority 92)** — free-form lookup. Two-pass LLM pipeline:
   - **P1 SEGMENT** identifies the lookup span around `_` (handles ambient phrasing, embedded WH-questions, compact factual claims).
   - **P3 ANSWER** produces the canonical short answer.
   The whole span is replaced with the answer (WIPE mode) or just the `_` is filled (FILL mode), determined heuristically by the input shape (`is _` / `= _` / `? _` → FILL; `<phrase> _` → WIPE). Opt-in via `fluid-blank-mode: on`.

3. **`ClassifiedSourceGroup` (priority 90, legacy opt-in)** — pre-fluid-blank dispatcher that picked one of N specialised modes (math / factual / translation / spelling / color / http / timezone / roman / grammar) per input via fast heuristics + LLM classifier fallback. Off by default. Flip on via `classified-blanks-mode: on` for the sharper per-mode prompts when fluid-blank's general prompts aren't tight enough.

---

## Scope filtering

Every `ConfigSource` has a `scope` field (`'words'`, `'blanks'`, `'all'`) that gates whether the source runs for a given input. The check is in `ConfigSource.supports()`:

| Scope | Activates when… | Purpose |
|-------|-----------------|---------|
| `words` | No word equals `_` | Word alternatives. Skipped on `_` so word-alts don't compete with blank-fill. |
| `blanks` | At least one word equals `_` | Blank-fill modes. |
| `all` | Always | Sources that apply regardless. |

The check is literal string equality (`w === '_'`), not a regex. A word must be exactly `_` to trigger blank mode.

---

## Parser types (used by `ConfigSource` blank modes)

| Parser | Input format | Response format | Evaluator | Use case |
|--------|-------------|-----------------|-----------|----------|
| `math` | Text with `_` replaced by `BLANK` | `COMPUTE=<expression>` | Safe recursive-descent (`+ - * / % ()`) | Arithmetic: `4 * 12 = _` |
| `compute` | Text with `_` replaced by `BLANK` | `COMPUTE=<expression>` | `Function()` (unsafe; supports `Math.pow`) | Advanced math only in trusted environments |
| `answer` | Text with `_` replaced by `BLANK` | `ANSWER=<value>` | Literal string, capped at 100 chars | Factual: `Capital of France is _` |
| `alternatives` | Indexed format `0=word1 1=word2` | `INDEX:alt1,alt2,alt3` per line | Regex extraction; original prepended for non-blank positions | Word alternatives + grammar fill |
| `raw` | Text with `_` replaced by `BLANK` | Full response | Trimmed string | Free-form single-answer blanks |

For `math`, `compute`, and `answer` parsers, the result is a single alternative attached to the first `_` position. `alternatives` can return results for multiple positions.

---

## Portability (what the standard requires)

A conforming integration must:

- Detect `_` in user input and call the resolver with the full text + word indices.
- Display blank-fill results the same way as regular alternatives (cycling, secondary display).
- NOT trigger context invalidation when cycling the blank itself — only surrounding-word changes invalidate the slot.
- Handle the async nature of blank-fill: show the `_` until results arrive, then splice in the value.
- For keyword-bound blanks: route `_` substitutions through the host's blank dispatch (`blankInvoke` for sandboxed hosts, `spawnProcess` for native hosts running shell scripts).
