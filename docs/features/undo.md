# Undo / Redo

Natural-language undo of what OpenCues did. Type `undo _` and the last
change the runtime made — a blank fill, a `_` substitution, an agent
rewrite, a settings change, a volume/brightness set — is reverted. Type
`redo _` to re-apply it. Add a count to go deeper: `undo 3 _`.

ON by default. Disable via `undo-mode: off` in `~/.cues/OPENCUES.md`.

---

## What it reverts

One `undo _` reverts one *transaction* — everything a single action
changed, together:

- **Text the runtime spliced into your buffer** — fluid-blank answers,
  transform-blank rewrites, keyword-blank fills, cycling steps,
  agent-rewrite hunks. Rapid cycling bursts (volume stepped six times)
  coalesce into one transaction, so one undo returns to where the burst
  started.
- **Settings writes** — a `voice mode off _` summon or a satellite
  cycle wrote OPENCUES.md; undo restores the prior value (a provider
  switch restores both the provider and its paired model).
- **OS state** — volume/brightness sets are restored to the value read
  just before the change.
- **IDENTITY.md / NOTES.md writes** — `set sentinel city oslo _` undoes
  as `remove sentinel city`; a saved note undoes as its deletion. The
  inverse runs through the same validator as the original write.

Changes survive submitting a message: `volume 40 _`, send, then
`undo _` in the next message still restores your volume. (The *text*
part of an old message can't be reverted anymore — undo says so and
reverts the rest.)

## The honesty rules

Undo never guesses:

- A reverted text span must still be **findable, exactly once**, in
  your buffer. If you edited it away — or the same text now appears
  twice — that part is skipped and reported, never approximated.
- A setting or OS value is only restored if it still holds what the
  change wrote. If you hand-edited OPENCUES.md or another app moved the
  volume since, undo won't clobber that.
- Partial results are reported as such (statusline + log), never
  silently smoothed over. When nothing at all is undoable you get an
  inline `[OpenCues: nothing to undo]` note — one backspace clears it.
- External effects of user-pack blanks (a script that called an API,
  fetched, executed) are **not reversible** and are reported as such;
  the text they inserted still reverts.

## Language invariance

The trigger is classified by the same LLM call as
[fluid-config](fluid-config.md), not by the English word "undo" — so
`元に戻して _`, `deshacer _`, `rückgängig _`, `отменить _`, `เลิกทำ _`
all work, and counts normalize from words in any language
(`annuler les trois derniers _` → undo 3). Bench: 100% precision /
93% recall across the multilingual suite
(`tests/benchmarks/fluid-config/cases-undo.ts`).

"Undo my last commit _" is NOT an OpenCues undo — the classifier routes
requests about things outside your buffer (git, deploys, homework) to
the normal lookup path.

## Where it works

Every host: Claude Code, OpenCode, Gemini CLI, shell (`oc-shell`), and
chrome.

## See also

- [fluid-config](fluid-config.md) — the classifier undo rides on
- `docs/architecture/undo.md` — journal design, exact-match-or-refuse
  policy, what's out of scope
