# Post-cleanup verification

Walk-through to confirm the system works end-to-end after the rename + simplification chain (`6bdfd18..f3e6413`). Tick each box as it passes, leave failing ones unchecked + add a note. Self-deleting (`git rm verify.md`) once everything's green.

Setup expected:
- `~/.opencues/` freshly seeded (no `controls.md`, no `controls/`)
- `~/.opencues/opencues.md` has all 5 flags: `fluid-blank-mode: on`, `spelling-mode: on`, `word-alts-mode: on`, `default-word-alts: off`, `classified-blanks-mode: off`
- OpenCode patched + launched

If you don't have a working install, see the very-bottom "Reset" recipe.

---

## A. Smoke (do these first — if any fail, stop and debug)

- [ ] `opencues run opencode` launches and the TUI loads with no errors.
- [ ] `opencues logs --tail` shows `Resolver: built with N sources` where N ≥ 1 (typically 3–5).
- [ ] Type `the boy jumpved over the dog` — `jumpved` dims with `jumped` as the alt within ~500ms. (proves: config-loader → resolver → SpellingSource → DimRender pipeline)
- [ ] `capital of france _` — fills with `Paris`. (proves: fluid-blank P1+P3 + auto-substitute)
- [ ] `volume _` — fills with current system volume (`50%` or whatever). (proves: keyword-bound BlankSource + script dispatch)

---

## B. Cue surfaces — each opt-in flag

Flip each flag in `~/.opencues/opencues.md`, save, type a space in the host (triggers hot-reload), verify behaviour.

### B.1 — `word-alts-mode`
- [ ] ON: type `the boy jumped over the dog` → some content words dim with synonyms (Up cycles).
- [ ] OFF: type the same → no words dim.

### B.2 — `default-word-alts` (the "everything coloured" toggle)
- [ ] OFF + word-alts ON: `the contract shall indemnify the diagnosis` → only `contract`, `shall`, `indemnify`, `diagnosis` colour (legal + medical match). `the` stays plain.
- [ ] OFF + word-alts ON: `the boy jumped over the dog` → nothing colours (no domain matches, no default to catch).
- [ ] ON: same input as above → every content word colours.

### B.3 — `spelling-mode`
- [ ] `the boy jumpved` → `jumpved` dims with `jumped`.
- [ ] `i recieve definately accomodate` → three corrections offered.
- [ ] `Paris is great` → proper noun NOT flagged.
- [ ] `the API returned 200` → acronym + number NOT flagged.
- [ ] OFF: `jumpved` stays plain.

### B.4 — `fluid-blank-mode`
- [ ] `capital of france _` → `Paris`.
- [ ] `4 * 12 = _` → `48` (FILL — sentence preserved).
- [ ] `unicode for em dash _` → `U+2014` (WIPE — lookup phrase replaced).
- [ ] `100 celsius in fahrenheit _` → `212`.
- [ ] `hex for navy blue _` → `#000080`.
- [ ] `8 in roman numerals _` → `VIII`.
- [ ] `click _ to continue` → stays as `_` (P1 bails — not a lookup).
- [ ] `_` alone → stays as `_`.
- [ ] **Latency:** typing `_` should fire substitution within ~500ms (debounce-bypassed fast-path).
- [ ] OFF: nothing fluid-blanks; `capital of france _` stays as `_`.

### B.5 — `classified-blanks-mode` (legacy opt-in)
- [ ] OFF: skip — covered by fluid-blank.
- [ ] ON (optional): `2 + 2 = _` → `4` via classifier. Confirms the dormant path still works for users who opt in.

---

## C. Every shipped blank (`~/.opencues/blanks/`)

| Blank | Test | Pass? |
|---|---|---|
| **volume** | `volume _` → `50%`. Up/Down → 56%/44%, OS volume changes. | [ ] |
| **brightness** | `brightness _` → `70%`. Up/Down → 80%/60%, screen changes. | [ ] |
| **affirmations** | `affirmation _` → "I am strong". Up cycles "I am brave"…"I am enough"…`_` (dismisses). | [ ] |
| **stocks** | `nvda _` → "Nvidia $209.25". `Reddit Stock _` → "Reddit Stock $133.44". (needs `FINNHUB_API_KEY`) | [ ] |
| **weather** | `London weather _` → temp + cloud cover. `Tokyo forecast tomorrow _` → tomorrow. | [ ] |
| **hackernews** | `hn _` → "HackerNews" + first headline. Up cycles ~30 headlines. | [ ] |
| **crypto** | `btc _` → "Bitcoin $X". `eth _` → "Ethereum $Y". | [ ] |
| **countries** | `population of france _` → "67.7M". `capital of japan _` → "Tokyo". | [ ] |
| **dictionary** | `define ephemeral _` → definition. | [ ] |
| **prompt** (improver) | `improve prompt write a poem _` → entire input replaced with improved prompt. Up/Down cycles 3 versions + original. | [ ] |
| **answer** | (round-trip Q&A, similar to prompt) | [ ] |
| **opencues** | `opencues settings _` → `voice-mode active`. Selector cycles settings, satellite cycles values. | [ ] |

---

## D. Cycling, spans, multi-word

- [ ] **Multi-word LLM alt:** `the attorney filed the case` — `attorney` cycles to `lawyer`, then `legal eagle` (multi-word span, dims as one unit, navigates as one stop).
- [ ] **Two concurrent spans:** sentence with two cycle-able multi-word words. Cycle each independently; the other stays put.
- [ ] **Cycle survival on prefix:** prepend `Yesterday ` to a sentence with cycled words. Cycle progress follows them to new positions.
- [ ] **Edit clears alts:** delete a word — its alts disappear, neighbours unaffected.
- [ ] **Cursor preservation:** cycle a 4-letter word to a 6-letter alt with cursor at the end → cursor shifts +2; cursor before the word → unchanged.
- [ ] **Dismiss:** `affirmation _` → cycle past last value to `_`. Re-typing nearby text doesn't re-fill.

---

## E. Selector + Satellite (`opencues settings _`)

- [ ] `opencues settings _` → expands to `voice-mode active`. Trigger keywords cleared (`blankClearKeywords: true`).
- [ ] **Selector cycling:** Up on `voice-mode` → `debug-mode off`, satellite updates to current value.
- [ ] **Satellite cycling:** Up on `active` → `inactive`. Verify `~/.opencues/opencues.md` now has `voice-mode: inactive` on disk.
- [ ] **Pair cleanup:** delete `active` → both `voice-mode` and `active` removed (`blankClearOnEdit`).
- [ ] **Hot-reload race guard:** flip voice-mode via cycling, then immediately type a space. The just-written value is NOT clobbered (2.5s suppression window).

---

## F. Hot-reload

- [ ] Edit `~/.opencues/cues.md` (add a tip in the JSON block) — type a space in the host, tip surfaces within ~2.5s.
- [ ] Edit `~/.opencues/blanks/volume/cue.md` — change `blankSuffix: %` to `blankSuffix: pct`. Re-trigger `volume _`. New suffix shows.
- [ ] Edit `~/.opencues/opencues.md` — flip `fluid-blank-mode: off`. `capital of france _` now stays as `_`. Flip back on.

---

## G. CLI sanity

```bash
opencues list                      # cues + blanks listed; no "controls" section
opencues list --blanks             # only blanks
opencues new blank foo --project   # scaffolds .opencues/blanks/foo/cue.md
opencues edit blanks               # opens ~/.opencues/blanks.md in $EDITOR
opencues validate                  # 0 errors on a fresh install
opencues which                     # all paths exist with ✓
opencues doctor                    # passes
opencues debug on                  # toggles debug-mode in ~/.opencues/opencues.md
opencues logs --tail               # follows /tmp/opencues.log
```

- [ ] All commands above succeed with sensible output.
- [ ] `opencues new control foo` → errors with "unknown kind 'control'" (no silent alias).
- [ ] `opencues edit controls` → errors (no silent alias).
- [ ] `opencues list --controls` → errors or ignores the flag.

---

## H. Migration boundary (no back-compat)

- [ ] Move `~/.opencues/blanks.md` to `~/.opencues/controls.md`, restart host. Confirm: zero blanks load (no fallback). Restore.
- [ ] Move `~/.opencues/blanks/` to `~/.opencues/controls/`, restart host. Confirm: zero blanks load. Restore.

---

## I. Automated suites (one shot, defensive)

```bash
cd packages/opencues-core    && npm test    # expect 363 pass / 7 skip
cd packages/opencues-runtime && npm test    # expect 522 pass
cd integrations/chrome       && npm test    # expect 5 pass
cd integrations/chrome       && npm run typecheck   # clean
bash tests/templates/run.sh                  # init-flow + blanks-shapes
```

- [ ] All 4 suites green.

---

## Reset recipe (if you need to start fresh)

```bash
opencues uninstall --all
rm -rf ~/.opencues
opencues install opencode    # chains seed-configs which creates fresh ~/.opencues/
```

`opencues uninstall` reverts host patches but **does not touch `~/.opencues/`**. The user-config wipe (`rm -rf ~/.opencues`) is what makes seed-configs do work.

---

## Known gotcha: `seed-configs` is first-time-only

The SEED phase **skips files that already exist with content** to preserve user customisations. That means when shipped defaults gain new fields (e.g. `fluid-blank-mode`, `spelling-mode` were added to `opencues.md` after initial install), your existing `~/.opencues/opencues.md` silently lacks them. Every cue surface defaults to OFF when its flag is missing, so this surfaces as "feature doesn't fire" with no error.

**How it bit me here:** my install pre-dated the new flags. `~/.opencues/opencues.md` existed without them. Re-running `opencues seed-configs` skipped the file. Re-running `opencues install opencode` chained `seed-configs` which still skipped the file. Spelling + fluid-blank were silently off until I `rm -rf ~/.opencues && opencues install opencode`.

The CLI now warns about this on every `seed-configs` run when any file is skipped — points at:
- `rm ~/.opencues/<file> && opencues seed-configs` (re-seed one file, lose only that file's customisations)
- `rm -rf ~/.opencues && opencues seed-configs` (full reset)
- merge by hand from `<repo>/defaults/<file>`

Followup item I want eventually: an UPDATE phase in seed-configs that injects missing keys into existing opencues.md without touching customisations.

---

## Failures log

> Add a line per failing item with what you observed, then come back and we'll debug.

- (none yet)
