# Flaky / environment-dependent scenarios

Scenarios in this directory aren't part of the always-pass suite that
runs against any clean OC checkout. They depend on:

- **`04-blank-fill-weather.json`** — network access (live weather API).
  Reliable in a connected environment, fails on air-gapped CI.
- **`05-numeric-step.json`** — assumes the runtime's step-cue logic
  recognises `5f` patterns. In some configurations the numeric-step
  source is disabled (e.g. `word-cues-mode: off`). Fails when the
  user's `~/.cues/OPENCUES.md` doesn't enable it.
- **`06-escape-clears.json`** — assumes Escape deactivates the
  highlight. On OC v1.4.11 with the current OC bootstrap,
  Escape isn't routed through Navigation's deactivation path
  (`consumed: false` in the event stream). Either the runtime needs
  to claim Escape unconditionally or the bootstrap's keyboard hook
  needs to forward Escape ahead of the host's own handlers — open
  question, not a harness bug.

Move scenarios INTO this folder when they fail for environmental
reasons; move them OUT when their underlying issue is fixed in the
runtime / host bootstrap. The main scenarios directory should stay
green on every clean checkout.
