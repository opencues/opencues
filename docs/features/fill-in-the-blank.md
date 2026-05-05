---
last_updated: 2026-05-05
---

# Fill-in-the-Blank

Typing `_` (underscore) creates a blank that the system fills contextually. Blanks reverse the direction of regular cues — instead of the LLM offering you alternatives, you're explicitly summoning a value.

---

## Dispatch order

Every `_` slot routes through the same priority chain. The three sources race; the highest-priority one that *claims* the slot wins.

1. **`BlankSource` (priority 95)** — keyword-bound. If any registered blank's `blankKeywords` matches a phrase within `blankProximity` words of the `_` (default 0 — strictly adjacent), that blank claims the slot. Auto-populates with the blank's current value (script `get` or runtime-class `blankInvoke`). Up/Down cycling writes back. Examples: `volume _` → `50%`, `nvda _` → `$209.25`, `define ephemeral _` → `lasting briefly`. See [Cue-Blanks](cue-blanks.md).

2. **`TransformBlankSource` (priority 93)** — imperative instructions. Three-pass LLM pipeline (EXTRACT → APPLY → VERIFY) plus a generative branch when the input has no target. Cedes to any keyword-bound match first (re-checks `blankKeywords` in `supports()`); otherwise EXTRACT classifies whether the input is actually a transform.
   - **Transform mode**: `change boy to girl _`, `make this past tense _`, `translate to french _`. EXTRACT splits into instruction + target; APPLY rewrites; VERIFY checks for defects and repairs.
   - **Generative mode**: `write a poem _`, `compose an email _`, `give me 5 startup ideas _`. Single-pass APPLY, no VERIFY (~700–1200ms).
   - **Agent-task mode**: `agentically X _`, `add task X _`, `stop task _`, `current task _` route into the runtime's agent state machine via TASK_* verdicts (no APPLY/VERIFY).

   See [Transform Blanks](transform-blank.md) and the canonical reference at `docs/architecture/transform-blank.md`. Opt-in via `transform-blank-mode: on`.

3. **`FluidBlankSource` (priority 92)** — free-form lookup. Two-pass LLM pipeline:
   - **P1 SEGMENT** identifies the lookup span around `_` (handles ambient phrasing, embedded WH-questions, compact factual claims).
   - **P3 ANSWER** produces the canonical short answer.
   The whole span is replaced with the answer (WIPE mode) or just the `_` is filled (FILL mode), determined heuristically by the input shape (`is _` / `= _` / `? _` → FILL; `<phrase> _` → WIPE). Opt-in via `fluid-blank-mode: on`.

---

## Scope filtering

Every `ConfigSource` has a `scope` field (`'words'`, `'blanks'`, `'all'`) that gates whether the source runs for a given input. The check is in `ConfigSource.supports()`:

| Scope | Activates when… | Purpose |
|-------|-----------------|---------|
| `words` | No word equals `_` | Word alternatives. Skipped on `_` so word-cues don't compete with blank-fill. |
| `blanks` | At least one word equals `_` | Blank-fill modes. |
| `all` | Always | Sources that apply regardless. |

The check is literal string equality (`w === '_'`), not a regex. A word must be exactly `_` to trigger blank mode.

---

## Parser types (used by `ConfigSource`)

| Parser | Input format | Response format | Evaluator | Use case |
|--------|-------------|-----------------|-----------|----------|
| `alternatives` | Indexed format `0=word1 1=word2` | `INDEX:alt1,alt2,alt3` per line | Regex extraction; original prepended for non-blank positions | Word alternatives (default for word-cue sources) |
| `raw` | Text with `_` replaced by `BLANK` | Full response | Trimmed string | Free-form single-answer cases |

---

## Portability (what the standard requires)

A conforming integration must:

- Detect `_` in user input and call the resolver with the full text + word indices.
- Display blank-fill results the same way as regular alternatives (cycling, secondary display).
- NOT trigger context invalidation when cycling the blank itself — only surrounding-word changes invalidate the slot.
- Handle the async nature of blank-fill: show the `_` until results arrive, then splice in the value.
- For keyword-bound blanks: route `_` substitutions through the host's blank dispatch (`blankInvoke` for sandboxed hosts, `spawnProcess` for native hosts running shell scripts).
