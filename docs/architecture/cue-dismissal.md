# Cue dismissal — architecture

Canonical reference for dismissing a cue: the `_` gesture on an advisory note,
the two grains behind it, the file it writes, and `opencues dismissals`. Read
this before touching `packages/opencues-runtime/src/state/cue-dismissals.ts`,
`packages/opencues-core/src/dismissals.ts`, the advisory branch of
`Cycling.stepUnderscore`, or the dismissal checks in DimRender and the resolver.
User-facing summary: `docs/features/cue-dismissal.md`.

## Why it exists

Contradiction and sentence cues are on by default and passive, so a wrong or
unwanted one costs nothing to ignore — once. Ignoring it every time is a
different matter, and before this the only recourse was turning the whole
feature off in `OPENCUES.md`. A cue you cannot silence individually is a cue
that eventually gets silenced collectively.

The shape is lifted from the life-context research prototype
(`research/propositional-dehydration`), whose p31 scenario pinned the lifecycle
across mute, revival, scoping and kill at 7/7.

## Two grains

| | Mute | Forget |
|---|---|---|
| Gesture | `_` once on the note | `_` twice, within 800 ms |
| Lives in | memory (`cue-dismissals.ts`), per host process | `<cues>/dismissals.json` |
| Lasts | `MUTE_MS` (30 min), then lapses on its own | until restored |
| Listed by `opencues dismissals` | no | yes |

The mute is what makes the feature safe to ship. Without it the only response
to a cue that is right but badly timed is the permanent one, and a user will
take it — after which the feature is dead for them. With it, "not now" and
"never" are different keystrokes.

## The key is TEXT, not an id

⚠ The single most important thing here, and the one that is easy to get wrong.

A session-contradiction flag cites a `commitmentId` (`c1`, `c2`, …). Those look
like identities and are not: `buildSessionCommitmentsSnapshot` assigns them
**positionally on every write**, and `mergeSessionCommitments` emits fresh
entries first — so one new decision renumbers the whole watchlist. Verified on
real snapshots: "the shader border width is set to 8px" is `c1` in one
watchlist and `c5` in another.

Keying a dismissal on an id would therefore silence whichever cue happens to
occupy that slot on the next tick. That is worse than not working, because it
would look like it worked.

So the key is `dismissalKey(text)` — lowercase, strip punctuation, collapse
whitespace, drop a leading note emoji — which is deliberately identical to
`normalizeCommitmentStatement`, the normalization the watchlist merge and the
supersession pass already use. One notion of "the same claim" across the
feature; a test pins the two functions to each other.

**Known limit:** a rephrased restatement normalizes differently and reads as a
new cue. Forget covers exact restatements; mute covers the here and now. This
is documented rather than machined around, because the alternative (fuzzy
matching what to suppress) fails in the direction that hides things the user
did not ask to hide.

## What `_` may dismiss

`dismissalTargetOf(def)` returns a target only for a **pure advisory**: a def
carrying a `cueTip` with nothing to cycle to (`alternatives.length <= 1`) — a
calendar clash, a contradiction whose verdict is advice rather than a fix.

That is deliberate, and it is what makes the gesture free. On a cycleable cue
`_` already walks the alternatives, and reaching the reconciled rewrite IS the
answer there — overloading the key would take that away to solve a problem
those cues do not have. A cycleable cue therefore keeps `(underscore to cycle)`;
only an advisory shows `(underscore to dismiss)`.

## Where it is enforced

Three places, each covering something the others cannot:

1. **`Cycling.stepUnderscore`** — the gesture. Checked BEFORE the
   `alternatives.length <= 1` guard, which is exactly what would otherwise drop
   advisories on the floor and let the `_` type into the buffer. Same liveness
   and cursor gates as the cycle path, so dismiss fires precisely where the note
   is painted. Deletes the def, retires the note's how-to hint, repaints, and
   consumes the keystroke.
2. **`DimRender`** — the paint. A dismissed cue's note never renders, which also
   covers a def registered *before* the dismissal.
3. **`Resolver`** — the registration. A dismissed cue is never registered at
   all, so it stays out of the def table and out of the secondary display too.

## Persistence

`startCueDismissals` (boot-common) hydrates the forgotten set at boot, re-reads
`<cues>/dismissals.json` on a 4 s mtime gate, and registers the sink that
writes a new forget (read-modify-write, so a concurrent host's dismissal is not
lost and a hand edit survives). It is wired from `buildSharedRuntime`, so every
host band gets it from one line.

The re-read is what makes the CLI a live undo: restore a cue and the running
host picks it up within seconds, no restart.

**The file is user-level**, deliberately not scoped per working directory like
the commitments watchlist. A watchlist is session state; "never show me this
again" is a standing preference.

**Chrome has no filesystem**, so no sink is registered there and forget degrades
to a 24 h mute. `pressDismiss` does NOT add to the forgotten set in that case —
claiming permanence the next restart would expose is worse than a mute that
behaves as advertised.

## The undo surface

`opencues dismissals` mirrors `opencues identity`: bare invocation is an
interactive toggle list, subcommands are scriptable (`list [--json]`,
`restore <n|phrase>`, `clear`, `path`). Toggles are held in memory and applied
on accept; Esc writes nothing, so opening the list to look is free.

A silent kill-switch is a support burden, so the dismissal path is loud in the
places that cost nothing: every press logs its grain and label, and the CLI
prints the file path with the list.

## Where to touch

- `packages/opencues-core/src/dismissals.ts` — key, label, parse/serialize,
  add/remove. Pure; the CLI and the runtime share it so they cannot drift.
- `packages/opencues-runtime/src/state/cue-dismissals.ts` — the two grains, the
  sink, `dismissalTargetOf`.
- `packages/opencues-runtime/src/modules/cycling.ts` — the advisory branch of
  `stepUnderscore`.
- `packages/opencues-runtime/src/modules/dim-render.ts` — the hint text and the
  paint-time suppression.
- `packages/opencues-runtime/src/modules/resolver.ts` — registration-time skip.
- `packages/opencues-runtime/src/boot-common.ts` — `startCueDismissals`.
- `packages/opencues-cli/src/commands/dismissals.cjs` — the undo surface.

Tests: `dismissals.test.ts` (core), `cue-dismissals.test.ts` (grains),
`cue-dismissal.scenarios.test.ts` (the user journey), `dismissals.test.cjs`
(CLI, against a sandbox `$OPENCUES_HOME`).

## Not in v1

- **Dismissing a cycleable cue.** `_` means cycle there; see above.
- **Dismissal by claim rather than by advisory text.** A contradiction cue's tip
  is data-derived and often specific ("15 Aug 2026 is a Saturday"), so forgetting
  it is narrow by construction. Widening that to the underlying claim needs the
  claim to have a durable identity, which the watchlist does not yet give it.
- **A settings scalar.** Dismissal is a gesture, not a mode; there is nothing to
  turn on. `opencues dismissals clear` is the reset.
