# 11 — Flow State Mechanisms

For blog post #12: "Flow state".

This file extracts every concrete mechanism in OpenCues that exists *to
preserve the user's flow*. None of these are framed in marketing as
"flow-state features" — they're just engineering choices. But they're
all flow-state choices.

## Definition of flow state (for the post's purposes)

Flow is the state where the user's attention stays in the artifact (text
they're writing) and not in the tool. Anything that pulls attention to
the tool — popups, modals, "do you want to accept?" dialogs, latency
spikes, mode switches, lost cursor positions, surprising state changes —
breaks flow.

OpenCues' design contains several specific mitigations.

## Mechanism 1: Cycling in place (no picker UI)

The Up/Down cycling pattern means the user *never sees a popup*. To get
a different word, they navigate to the dim word (Ctrl+Alt+Right) and press
Up or Down. The substitution happens in their text, in place.

From [`04-inline-cues.md`](04-inline-cues.md):
> Cycling preserves flow. No "picker" UI. No menu. Up/Down cycles in
> place. The hand never leaves the typing position.

Compare to standard autocomplete: a popup appears, you scroll a list, you
hit Enter to commit. That's a mode switch. Cycling in place isn't.

## Mechanism 2: Resolver Skip Filter — "the system remembers what I chose"

From `damon.md`:

> **Resolver Skip Filter** — once you cycle `attorney → lawyer`, the LLM
> is *not* re-asked about "lawyer" on the next pulse. Without this, the
> resolver would silently swap your alt track to a "lawyer"-themed one
> (`client / customer / person`). Saves tokens AND prevents drift.

Without this, the user's choice would silently vanish on the next pulse.
With it, the user feels: "I chose this; the system respects it."

## Mechanism 3: Deterministic Relocate — cycle progress survives edits

> **Deterministic Relocate** — type "Yesterday " in front of a sentence
> with cycled words, and the cycle progress *follows the words to their
> new index*. Only relocates when the match is unambiguous; ambiguity
> drops cleanly rather than guessing.

If you've already cycled `happy → joyful` and you edit the *prefix* of the
sentence, the `joyful` doesn't pop back to `happy`. The runtime tracks
the word's identity through index shifts.

This is a bug-fix-shaped feature: the obvious naive implementation
re-numbers everything by index after edits, and the user's prior cycling
gets lost. Deterministic Relocate is engineering work specifically to
prevent that flow-breaking surprise.

## Mechanism 4: Per-Word Clearing — local edits don't break global state

> **Per-Word Clearing** — Editing a word clears its alternatives. Other
> words in the input are unaffected.

Edit a single word and only that word's cue state resets. Other dimmed
words keep their alternatives. The user can fix a typo without losing the
work the system has done elsewhere in the sentence.

## Mechanism 5: Cursor Preservation — your place doesn't move

> **Cursor Preservation** — Cursor position adjusts when a word changes
> length so you don't lose your place.

When cycling `happy → joyful` (length 5 → 6), the cursor (if elsewhere)
shifts by +1 to keep its relative position. You don't have to re-find
where you were typing.

There's also `docs/features/cursor-preservation.md` for the full
behaviour, plus `cursor-positioning.md` for the integration-specific
adjustments during blank fill.

## Mechanism 6: Cursor Navigate — the cursor IS the navigator

> **Cursor Navigate** (optional) — Highlight automatically follows cursor
> to navigable words. Toggle with the `cursor-navigate` setting.

When enabled, you don't need Ctrl+Alt+Right to navigate. Just type or
click; whichever word your cursor is on becomes highlighted, and Up/Down
cycles it. One less keystroke combo to remember.

This is opt-in (toggleable via `cursor-navigate: active`) because some
users prefer the explicit Ctrl+Alt+Right gesture. The opt-in itself is a
flow choice — don't impose a pattern.

## Mechanism 7: Hot-reload — edit configs while using them

From `CLAUDE.md`:
> `.md` config files (`CUES.md`, `BLANKS.md`, `cues/`, `blanks/`) hot-
> reload within ~2 seconds on the next keystroke — no restart needed.

You can be inside Claude Code, realize a cue is wrong, edit
`~/.cues/cues/legal/CUE.md` in another window, save, and the next
keystroke in your prompt picks up the change. No restart of CC. No
re-install. No build.

For users tuning their own setup, this is enormous. They never have to
leave the artifact (their prompt) to fix the tool.

## Mechanism 8: Re-evaluation on edit — blanks stay live

From `docs/glossary.md`:
> Blanks are automatically computed and re-evaluated on every edit. When
> the surrounding text changes, the blank's value updates. This means a
> blank is never permanently filled — it can always return to `_` and be
> re-evaluated in its new context.

If you fix a typo in `4 * 12 = _`'s context, the answer adjusts. The user
doesn't have to re-trigger anything. The system *stays caught up to the
text*.

This is the opposite of commit-once autocomplete (which forgets after
acceptance). Re-evaluation means blanks compose with editing rather than
fighting it.

## Mechanism 9: Auto-Submit (blanks-only)

> **Auto-Submit** — Analysis fires automatically after a pause in typing.
> Only unseen words are sent to the LLM.

The user doesn't press a "go" button. Pause typing → analysis fires.
Pulse → results dim words. The flow continues through the implicit-trigger
moment.

## Mechanism 10: The 500ms debounce — one clock for everything

From `docs/architecture/agent-task.md`:

> Reuses the Resolver's existing 500ms debounce timer (don't create a
> second one — keep the system to ONE clock).

When the agent-task feature was added, it didn't introduce its own debounce
— it shared the resolver's. One clock means the user feels a coherent
"the system processes after I pause" rhythm, not multiple competing
heartbeats.

## Mechanism 11: Cursor-adjacency exclusion — never edit the word you're typing

From `docs/architecture/agent-task.md`:

> The agent NEVER touches words owned by other sources. The same
> `isEvaluated()` cache prevents re-asking the LLM about words it just
> saw under the current task.

Cursor-adjacent words are excluded from evaluation. The user is *typing*
"con" → the agent doesn't try to autocorrect to "concerns" / "context" /
"conservatives." They wait for the user to finish.

This is a small specific rule with a big flow consequence.

## Mechanism 12: Ownership locks — what's filled stays filled

From `docs/features/cue-blanks.md`:

> The invariant: Only the user can clear `metadata.blankName`. The LLM
> cannot. This ensures blank positions are stable until the user
> explicitly edits them away.

Once a blank is filled (`volume 50%`), no LLM call will overwrite that
50%. The user-committed value is locked. The user knows the system won't
silently mutate things behind them.

## Mechanism 13: Stop semantics that respect ongoing work

From `docs/architecture/agent-task.md`:

> `stop task _`:
> - Clears the task state
> - Statusline `[task: ...]` disappears
> - **Existing dimmed edits stay** as DynDefs. The user can revert any
>   individual edit via cycling Down. They can also leave them as-is.
> - Don't auto-revert — that would be surprising.

When you stop the agent, the agent's existing work doesn't vanish. You
keep what you wanted, revert what you didn't, at your own pace. No
modal "do you want to keep all these edits?" dialog.

## Mechanism 14: The "secondary display" abstraction

The cue-tip is shown in a host-specific surface (status line in CC,
tooltip in Chrome, footer in OC). It's *outside the input*. The text
input is yours; the secondary display is the system's commentary. Two
different attentional surfaces. The user can ignore the secondary display
entirely without losing functionality.

## The HCI angle (for blog #12)

The big idea: **flow state isn't a feature, it's the absence of every
small interruption.** OpenCues earns flow by aggressively *not breaking
it* — no popups, no modals, no lost cursors, no forgotten choices, no
unrequested rewrites. Every mechanism above is a specific "we noticed
this would break flow and chose not to."

Some of them came from explicit design (Cycling in place, no popups);
some came from bug fixes (Resolver Skip Filter, Deterministic Relocate)
where the naive implementation had broken flow until someone noticed.

The lesson worth pulling out: **flow-preservation is engineering work,
not a checkbox feature.** It's discovered iteratively by paying attention
to what feels off.

## Pitfalls to mention

- **Some flow-preservation has costs.** Resolver Skip Filter saves tokens
  but means the user has to *manually* clear a cycled word to re-ask the
  LLM. Trade-off: respect prior choice over "always-fresh suggestions."
- **Auto-submit can fire while still composing.** 500ms debounce strikes
  most cases but not all. Mitigation: cursor-adjacency exclusion (the
  word you're typing right now isn't sent).
- **Re-evaluation can surprise.** Editing a math blank's prefix changes
  the answer. Correct but uncanny on first encounter.
- **Hot-reload race conditions.** When mutations happen in process AND
  on disk (selector/satellite cycling writes the settings file *and*
  updates in-memory state), there's a race window where a reload could
  read the still-stale file. Mitigation: 2.5s suppression window after
  writes. Documented in CLAUDE.md.

## Where this material lives

- `damon.md` § "Other Features" — the named flow-preservation list
- `CLAUDE.md` § "Hoisted-blank writes vs ConfigLoader hot-reload" —
  the race fix
- `docs/features/cursor-preservation.md`
- `docs/features/cursor-navigate.md`
- `docs/features/deterministic-relocate.md`
- `docs/features/per-word-clearing.md`
- `docs/features/auto-submit.md`
- `docs/architecture/agent-task.md` § "Cursor-adjacency rule" + "Stop
  semantics"

## Quotable lines

- "Cycling is in place. The hand never leaves the typing position."
- "Saves tokens AND prevents drift."
- "Cycle progress follows the words to their new index."
- "Don't auto-revert — that would be surprising."
- "Reuses the Resolver's existing 500ms debounce timer — keep the system
  to ONE clock."
- "Only the user can clear `metadata.blankName`."
- "Hot-reload within ~2 seconds — no restart needed."
