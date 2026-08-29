---
# ─────────────────────────────────────────────────────────────────
# example — minimal hello-world blank
#
# A deliberately tiny script-blank you can copy-and-edit.
# Production blanks (volume/brightness/weather) have many fields for
# many reasons; this one shows the minimum that fires.
#
# What it does: when you type `time _` the runtime calls
# ./time-blank.sh with `get`, which prints the local time (HH:MM)
# to stdout. That value replaces the `_` in the buffer.
#
# How the runtime picks it up: `blankKeywords` desugars into anchored
# shapes (synthesizeKeywordShapes) matched against the SENTENCE
# containing `_` — a keyword claims the `_` when it leads that
# sentence, with anything between keyword and `_` captured as the
# arg. On a match the runtime invokes the colocated script. The
# script gets stdin context words on `get`; on `set <value>` it
# would write the new value back. This example is GET-only — there's
# nothing to set on a clock.
#
# Why no `blankStep` / `blankSuffix` here? Defaults work for a
# read-only blank with no cycling. Look at
# defaults/blanks/volume/BLANK.md for the full set of options.
# ─────────────────────────────────────────────────────────────────

# Required — must match the folder name (the runtime keys on this).
name: example

# Shipped OFF — this pack is tutorial scaffolding to copy + edit,
# not a default-on blank. Remove the line (or set true) to enable it.
enabled: false

# Discriminator. `blank` means `_`-triggered slot (vs cue sources,
# which run on plain text). Cue sources omit this field.
type: blank

# Triggered when one of these leads the sentence containing `_`
# (each keyword desugars into an anchored shape; anything between
# keyword and `_` is captured as the arg, so `time _`, `time is _`
# and `time right now _` all fire). Use comma-separated short
# triggers — matched as whole words, case-insensitive.
blankKeywords: time, clock

# Auto-populate on text-change: as soon as the keyword+`_` pattern
# is detected, fire `get` without waiting for the user to navigate
# to the `_`. Read-only blanks always want this on.
blankAutoPopulate: true

# Read-only — the user can't cycle the value with Up/Down (you'd
# get an error from the script if they tried, since we don't
# implement `set`). Affirmations / volume blanks set this to false.
blankReadOnly: true

# The script that does the actual work. Relative paths (./X) are
# resolved against THIS folder. So time-blank.sh sits in
# defaults/blanks/example/ alongside this BLANK.md.
blankScript: ./time-blank.sh

# Sandbox the script. `strict` (recommended) is the most restrictive
# profile — the script runs without filesystem write, network, or
# environment access. `time-blank.sh` only needs to read the clock,
# so strict is the right pick. Use `sandbox: off` (with a comment
# explaining why) for blanks that legitimately need filesystem or
# network access — volume-blank.sh / brightness-blank.sh are
# canonical examples. See `docs/architecture/sandbox.md`.
sandbox: strict
---

# Try it

After `opencues seed-configs` copies this folder to `~/.cues/blanks/example/`,
fire up your editor and type:

```
the time is _
```

The `_` should become the current `HH:MM`. Backspace + retype to
refresh.

Edit `time-blank.sh` to change what the blank returns. The runtime
re-invokes the script on every fire — no caching at this layer.
