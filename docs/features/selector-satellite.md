---
last_updated: 2026-04-08
---

# Selector + Satellite Blanks

A selector+satellite blank is a single `_` that auto-populates into **two independent, navigable units** bound by a bidirectional parent↔child pointer. The selector chooses *what* is being configured; the satellite shows — and mutates — *its current value*. Cycling one drives the other.

Either side may be single-word or multi-word. A setting named `output-format` with values `[plain text, rich markdown, structured json]` inserts as `opencues settings output-format plain text` (three navigable units, with the multi-word satellite rendered as a span), and cycling the satellite replaces the full span atomically.

This is the mechanism behind `opencues settings _`, which becomes `opencues settings voice-mode active`.

---

## Why This Is Not Linked Words, a Span, or a List Control

| Feature | Shape | Cycle behaviour |
|---|---|---|
| **Linked words** | N independent words already in the text, each with an alts list. Siblings share a `currentAltIndex` (e.g. `boy`/`his` → `girl`/`her`). | Symmetric. All siblings step to the **same index** in lock-step. |
| **Multi-word span** | One alternative whose value is physically multiple words (e.g. `"Jeff Bezos"`). Only the origin index is navigable. | One cycle replaces the whole span as a unit. |
| **List control** | One blank cycling a flat, static or dynamically-fetched list. | One position, one list, no second word. |
| **Selector + satellite** | **Two independent words** where one `_` was. Each has its own alts list. Cycling the selector **swaps the satellite's entire alts list** to the new setting's valid values. | Asymmetric. Selector cycle → satellite follows (new text, new alts). Satellite cycle → persists to config; selector unaffected. |

The sharp distinction from linked words: with linked words the alts lists are aligned index-for-index and fixed. With selector+satellite the **satellite's alts list itself is replaced** when the selector moves — "valid values for `voice-mode`" and "valid values for `debug-mode`" are different universes. There is no shared cycle index, no lock-step. They are yoked by semantics (parent→child), not by aligned position.

---

## The Two Roles

**Selector (word N).** Identified by a `selectorWord` flag on its word definition. Carries a pointer to its satellite (`childIndex`) and a `currentSetting` field that is the authoritative logical state (distinct from the display text, though they usually match). Its alts list is the enumeration of all available setting names. Cycling it is read-only navigation across settings.

**Satellite (word N+1).** Identified by a `satelliteWord` flag. Carries a pointer back to its parent (`parentIndex`). Its alts list is **derived from whichever setting the selector currently points at** — it is rebuilt every time the selector moves. Cycling it triggers persistence.

The parent↔child link lives entirely in metadata. Selector and satellite are **not a span of each other** — they are two fully independent, individually navigable units.

---

## Multi-Word Spans

Either side of the pair — selector or satellite — may be a multi-word value. When multi-word, it is rendered as a **span**: multiple whitespace-delimited tokens that navigate, dim, and cycle as a single unit. This reuses the same span infrastructure as multi-word LLM alternatives (e.g. `"Jeff Bezos"` as one cycling option).

```yaml
# In opencues.md:
output-format: rich markdown
settings:
  output-format:
    tip: Response format style
    values:
      plain text: Unformatted plain text output
      rich markdown: Formatted markdown with styling
      structured json: Machine-readable JSON output
  display mode:
    tip: Layout mode
    values:
      focus: Single-pane focused view
      split pane: Side-by-side split layout
      zen: Distraction-free minimal view
```

Given this config, cycling the selector across settings produces:

| Selector | Satellite | Selector span | Satellite span |
|---|---|---|---|
| `voice-mode` | `active` | 1 word (no span) | 1 word (no span) |
| `output-format` | `rich markdown` | 1 word | 2 words (span) |
| `display mode` | `focus` | 2 words (span) | 1 word |
| `display mode` | `split pane` | 2 words (span) | 2 words (span) |

When a half is a span:
- Navigation lands on the span's origin index; non-origin positions are skipped.
- Dimming applies to the entire span as one visual unit.
- Cycling replaces the entire span text atomically. If the new value has a different word count (e.g. `split pane` → `zen`), all downstream word indices shift by the difference.

When a half is single-word, no span tracking is set up — it's a plain WordDef.

The word-count change between old and new values is handled on every cycle: if the total word count of selector+satellite changes, all WordDefs and span entries downstream of the pair shift their indices accordingly. The satellite's own index also moves if the selector's word count changes (since the satellite immediately follows the selector in the text).

---

## Read Flow (Abstract)

1. User types a phrase containing the control's keyword and a `_`.
2. The blank source matches the keyword within proximity of the `_`, shells out to the control's script, and receives a two-word response: `"<setting> <value>"`.
3. Because the control declares `blankSatellite: true` and the script output contains a space, the source emits a blank-fill result whose metadata carries both the selector value *and* the satellite value.
4. The integration's auto-populate layer replaces the `_` with `<setting> <value>` (two words in place of one), then constructs the two word definitions with their flags, cross-pointers, and alts lists.

The satellite's initial alts list is the integration's in-memory record of "valid values for this setting." Without that record the satellite degrades to a non-cyclable single-value label — cleanly, not crashing.

---

## Cycle Semantics

### Selector (read-only navigation)

1. Advance to the next setting name (wrap-around).
2. Ask the script for the current value of the *new* setting.
3. Rewrite **both** words in the text atomically (selector → new name, satellite → new value).
4. Rewrite the satellite's alts list to the new setting's valid values.
5. Update the selector's `currentSetting`.

No writes. Moving the selector is browsing.

### Satellite (write-through)

1. Walk the parent pointer to find which setting we're writing.
2. Advance in the satellite's current alts list (the valid values for that setting).
3. Call the script to persist: `set <setting> <newValue>`.
4. **Update the integration's in-memory current-values mirror immediately** so runtime consumers see the change before the next config reload.
5. Rewrite only the satellite word in the text.

The in-memory mirror update (step 4) is what makes cycling feel live — without it, downstream gates would lag behind by a hot-reload cycle.

---

## The Backing Config File (`opencues.md` Concept)

Selector+satellite stores its state in a config file dedicated to OpenCues' own system state, separate from the user's cue config. This separation is structural, not cosmetic: the user's cue config is authored and rarely rewritten; the system state file is rewritten on every satellite cycle. Mixing them would mean the user's work gets touched on every bit-flip.

The frontmatter has **two sections**:

```yaml
---
version: 1
voice-mode: active             # ← wired: gates TTS globally
debug-mode: off                # ← unwired: persists but no consumer yet
tips-mode: on
output-format: rich markdown   # ← multi-word value (satellite will be a span)
display mode: focus            # ← multi-word key (selector will be a span)
settings:
  voice-mode:
    tip: Gates TTS globally
    values:
      active: TTS reads tips aloud on navigation
      inactive: TTS is silenced
  debug-mode:
    tip: Enable debug logging output
    values:
      on: Debug output emitted to console
      off: Debug logging suppressed
  output-format:
    tip: Response format style
    values:
      plain text: Unformatted plain text output
      rich markdown: Formatted markdown with styling
      structured json: Machine-readable JSON output
  display mode:
    tip: Layout mode
    values:
      focus: Single-pane focused view
      split pane: Side-by-side split layout
      zen: Distraction-free minimal view
---
```

1. **Top-level keys** are the **live current values**. Cheap to read and write (a single `sed` line suffices). These are what runtime consumers read.
2. **The `settings:` block** declares each setting as a self-contained unit: its `tip:` (shown on the selector in the secondary display), and its `values:` (valid values, each with its own satellite tip). See [Tip Priority](tip-priority.md) for how these interact with other tip sources.

The split is intentional: hot-path reads/writes touch only the top-level keys; the `settings:` block is read-only and hot-reloaded for cycling and tip display.

### Script Contract

The backing script accepts three command forms:

| Call | Returns | Purpose |
|---|---|---|
| `get` | `"<settingName><sep><currentValue>"` | Initial auto-populate |
| `get <settingName>` | `"<currentValue>"` | Lookup when selector cycles |
| `set <settingName> <value>` | *(nothing)* | Persist when satellite cycles |

`<sep>` is the configured separator (see below). Both the setting name and the current value may contain internal spaces — multi-word selectors and multi-word satellites are fully supported.

Because the generic control-blank pipeline passes the matched keyword as the first argument to `get`, the script must treat unrecognised keys as "fall through to bare `get`" rather than error. Otherwise the initial capture fails.

### Separator Configuration

The separator between selector and satellite in the script's `get` output defaults to **tab** (`\t`). This can be overridden per control via `blankSatelliteSeparator` in `cue.md`:

```yaml
blankSatelliteSeparator: ' | '
```

The separator can be any string — single or multi-character. Splitting uses the first occurrence, so the separator is safe to use as long as it doesn't appear inside the setting name (the selector half). If it appears in the value (satellite half), that's fine — only the first occurrence delimits.

| Separator | Config | Trade-off |
|---|---|---|
| Tab (default) | *(omit field)* | Safest: never appears in names or values. Invisible in debug output. |
| ` \| ` | `blankSatelliteSeparator: ' \| '` | Readable when debugging. Unlikely to clash with content. |
| `:` | `blankSatelliteSeparator: ':'` | Compact. Clashes if setting names contain `:`. |
| ` :: ` | `blankSatelliteSeparator: ' :: '` | Multi-char, highly visible, very unlikely to clash. |

The script's `printf` must match whichever separator is configured:

```bash
# For tab (default):
printf '%s\t%s\n' "$first" "$val"

# For ' | ':
printf '%s | %s\n' "$first" "$val"
```

---

## Ownership Model: Pair Cleanup on Tamper

Selector and satellite share a lifecycle. The invariant they maintain together — "selector's `currentSetting` matches the satellite's content, and the satellite's alts equal the valid values for that setting" — can't survive an arbitrary user edit.

The rule: **if either side is deleted or edited to a value outside its alts list, both sides are cleared.** A valid cycle (landing on a value that *is* in alts) is not a tamper and does not trigger cleanup — it's just navigation.

Cleanup cascades through the parent↔child pointers:

- Clearing a `satelliteWord` → follow `parentIndex`, clear the selector.
- Clearing a `selectorWord` → follow `childIndex`, clear the satellite.

Both sides revert to plain words. The keyword-context suppression (below) releases automatically because it's predicated on the presence of a live selector.

---

## Keyword-Context Suppression

The words that triggered the capture — e.g. `opencues` and `settings` in `opencues settings _` — should not themselves be navigable or visually styled as interactive while the selector+satellite pair is live. They are the context that invoked the control, not alternatives the user should cycle.

The rule is evaluated dynamically on every render: **while a `selectorWord` exists anywhere in the text, any word to its left whose lowercase value matches an entry in the owning control's `blankKeywords` is suppressed from navigation and visual dimming.**

Properties:

- **Robust across re-analysis.** A one-shot clear would be overwritten the next time the LLM pipeline runs on the updated text. The dynamic filter is immune: as long as the selector is alive, the suppression applies.
- **Scoped.** No global ignore list is mutated. The moment pair cleanup fires, the check stops matching and those words become interactive on their own.
- **Nestable.** Multiple concurrent selector+satellite instances in the same input each suppress their own keyword context independently.

---

## Wiring Settings to Runtime Behaviour

The UI is only a bit-flipper. A setting can be in one of two states:

- **Wired** — a runtime consumer reads the current-values mirror and gates behaviour on it. Flipping the satellite has an immediate visible effect.
- **Unwired** — the setting exists in the backing file, cycles correctly, persists on disk, but nothing reads it yet. It's a placeholder waiting for a consumer.

Both states are valid and coexist in the same backing file. The selector+satellite UI doesn't distinguish between them — it cycles and persists either way. The difference is purely whether any code checks the value at the point of action.

### Example: `voice-mode` (wired)

`voice-mode` gates text-to-speech. Two TTS trigger points in the integration check the current-values mirror before spawning the speak process:

```text
when about to speak:
  if current["voice-mode"] == "inactive": skip
```

Because satellite cycling updates the in-memory current-values mirror immediately, flipping `active` → `inactive` silences the very next navigation — no restart, no wait for disk hot-reload.

### Example: `debug-mode` (unwired — ready to wire)

`debug-mode` exists in `opencues.md` with valid values `[on, off]`. It cycles, it persists, it shows in the selector+satellite UI. But nothing reads `current["debug-mode"]` yet. It's a stub.

To wire it, you'd pick the runtime point where debug logging is toggled and add:

```text
when deciding whether to write debug output:
  if current["debug-mode"] == "on": emit log line
```

Until that gate is added, `debug-mode` is a working, persistent, cyclable setting that does nothing — and that's fine. Shipping the setting before the consumer lets you validate the UI and the config shape without committing to the runtime behaviour.

### Pattern for adding a new setting

1. Add a top-level key + default value to the backing file.
2. Add the valid-value list under `settings:`.
3. (Optional, now or later) Pick the runtime consumer(s) and gate them on `current[<key>]`.

Step 3 is optional at creation time. The selector+satellite UI picks up the new key automatically at the next hot-reload. You can wire the consumer later when the feature is ready.

---

## When To Use This vs. Alternatives

- **Fixed enum of cases, each with its own fixed enum of values** → selector + satellite.
- **One cyclable list, keyword tells you which list** → list control (static `stepValues` or dynamic list).
- **One blank showing one value that writes back** → standard control-blank with `blankAutoPopulate`.
- **Two words that must change together on a shared axis with shared cycle state** → linked words.
- **Your "value" is semantically a multi-word phrase** → multi-word span.

If you're reaching for selector+satellite, the telltale signs are: the set of options cyclable on word N+1 **changes based on what word N is currently showing**, and cycling word N+1 has a **persistence side effect**.

---

## Integration Notes

The reference implementation is the Claude Code integration — see [`integrations/claude-code/docs/selector-satellite.md`](../../integrations/claude-code/docs/selector-satellite.md) for the patch-level implementation details (where in the `_cycleAlt` chain the selector and satellite paths live, how index shifting works during insertion, the two render passes that enforce keyword suppression, the TTS gate points, the hand-rolled `opencues.md` parser, and the globals it hydrates).
