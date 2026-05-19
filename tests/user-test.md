# User Tests

Manual sanity checks for the OpenCues system. Run after any code change + restart.

---

## Cues (word alternatives)

- [ ] Type `the happy dog` — words dim after ~500ms
- [ ] Navigate to a dimmed word (Ctrl+Alt+Left/Right) — highlights bold white
- [ ] Ctrl+Alt+Up/Down — cycles through alternatives
- [ ] Escape — clears highlight

## Spell-check (plain text)

(Spelling is shipped as a regular cue at `~/.cues/cues/spelling.md` and enabled by default.)

- [ ] Type `the boy jumpved` — `jumpved` dims with `jumped` as the alternative
- [ ] Up/Down on `jumpved` — cycles to `jumped`, back to `jumpved`

## Fluid blank (free-form `_` lookup)

(Requires `fluid-blank-mode: on`.)

- [ ] `2 + 2 = _` — fills with `4`
- [ ] `capital of France is _` — fills with `Paris`
- [ ] `unicode for em dash _` — fills with `U+2014`
- [ ] `100 celsius in fahrenheit _` — fills with `212`
- [ ] `_ alone with no lookup phrase` — stays as `_` (P1 bails on no recognisable lookup)

## Blanks

### Auto-populate
- [ ] `volume _` — `_` replaced with actual system volume (e.g. `50%`)
- [ ] Value is dimmed (gray)
- [ ] Status line empty (no `blankTip` set)

### Cycling
- [ ] Navigate to the value, Up — increases by 6 (e.g. `50%` → `56%`), actual volume changes
- [ ] Down — decreases by 6, actual volume changes
- [ ] Displayed value includes `%` suffix and matches actual system volume

### Keywords + proximity
- [ ] `volume _` — matches (adjacent, proximity 0)
- [ ] `audio _` — matches ("audio" keyword)
- [ ] `sound _` — matches ("sound" keyword)
- [ ] `volume is _` — does NOT match (1 word gap exceeds proximity 0)

### Fresh value
- [ ] Type `volume _`, let it populate
- [ ] Clear input, type `volume _` again — gets fresh value, not cached

### Ownership model
- [ ] `volume _` populates with e.g. "64%"
- [ ] Delete "64", type `hello` — "hello" gets normal grammar alts, NOT stuck as a blank
- [ ] Clear entire input — no ghost blank positions
- [ ] Type `the happy dog` — normal behaviour, no stale blank at any index

### Brightness blank
- [ ] `brightness _` — blank auto-populates with actual screen brightness (e.g. `70`)
- [ ] `bright _` — also matches
- [ ] Navigate to value, Up/Down — brightness changes by 10, displayed value updates


## List blanks

- [ ] `affirmation _` — blank auto-populates with "I am strong" (first value)
- [ ] Cursor moves to end of populated value
- [ ] Navigate to it — whole phrase highlighted as span
- [ ] Up/Down cycles: "I am brave" → "I am worthy" → "I am enough" → `_` (dismissible) → wraps
- [ ] Status line shows "Daily affirmations" (tip only, not the word)
- [ ] Cycle to `_` — blank is dismissed, auto-populate does NOT re-fire on next analysis

## Selector + satellite blanks (OpenCues settings)

### Auto-populate
- [ ] `opencues settings _` — keywords cleared, only `voice-mode active` remains (`blankClearKeywords: true`)
- [ ] Cursor lands at the end of the satellite word
- [ ] `voice-mode` dims gray; `active` dims gray

### Selector cycling (word N)
- [ ] Navigate to `voice-mode`, Up — becomes `debug-mode`, satellite simultaneously becomes `off` (or whatever its current value is)
- [ ] Up again — `tips-mode` + `on`
- [ ] Up again — wraps back to `voice-mode` + `active`
- [ ] Down cycles in reverse
- [ ] Cycling the selector does NOT write to `OPENCUES.md` (read-only navigation)

### Satellite cycling (word N+1)
- [ ] Navigate to the value word (`active`), Up — becomes `inactive`
- [ ] Check `OPENCUES.md` — the `voice-mode:` line is now `inactive` on disk
- [ ] Down — back to `active`, `OPENCUES.md` updates

### Voice-mode wired to TTS
- [ ] Flip satellite to `inactive` for `voice-mode`
- [ ] Navigate to a word with a speak:true tip — NO TTS fires
- [ ] Flip back to `active`
- [ ] Navigate to the same tip word — TTS fires again
- [ ] Effect is immediate (no restart, no hot-reload wait)

### Pair cleanup — blankClearOnEdit
- [ ] `opencues settings _` → resolves to `voice-mode active` (keywords already cleared)
- [ ] Delete the satellite word (`active`) — both `voice-mode` and `active` are removed from text (`blankClearOnEdit: true`)
- [ ] Re-type `opencues settings _` — re-expands cleanly

### Pair cleanup from the other side
- [ ] `opencues settings _` → resolves to `voice-mode active`
- [ ] Type over `voice-mode` with `xyz` (something not in the selector alts)
- [ ] Both `xyz` and `active` are removed from text (`blankClearOnEdit`)

### Hot-reload of OPENCUES.md
- [ ] Edit `OPENCUES.md`, change `voice-mode: active` to `voice-mode: inactive`, save
- [ ] Wait ~2s and type a space in Claude Code
- [ ] `opencues settings _` now auto-populates with `voice-mode inactive`
- [ ] Add a new valid value under `settings: voice-mode: values:` — add `muted: TTS muted`
- [ ] Save, wait ~2s, re-trigger — cycling the satellite now includes `muted`

## Read-only API blanks (stocks)

- [ ] `Reddit Stock _` — blank auto-populates with RDDT stock price (e.g. `$133.44`) (requires `FINNHUB_API_KEY`)
- [ ] `NVDA _` — blank auto-populates with Nvidia stock price
- [ ] Navigate to the price, Up/Down — no-op (read-only, no change)
- [ ] Status line shows "Stock price"
- [ ] Without `FINNHUB_API_KEY` — blank stays as `_` (graceful degradation)

### Keyword expansion
- [ ] `rddt _` → `Reddit $133.44` (ticker expanded to display name, blank filled)
- [ ] `NVDA _` → `Nvidia $133.44` (all-caps ticker — case-insensitive expansion)
- [ ] `reddit stock _` → `Reddit stock $133.44` (multi-word keyword, full name — no expansion needed)
- [ ] `Msft _` → `Microsoft $...` (spot-check another ticker)

## Read-only API blanks (weather)

- [ ] `London weather _` — blank auto-populates with current London weather (no API key needed)
- [ ] `Tokyo forecast tomorrow _` — tomorrow's Tokyo forecast
- [ ] `Uganda forecast weekend _` — weekend forecast for Uganda
- [ ] `Kenya forecast weekly _` — 7-day forecast
- [ ] `weather _` — defaults to London
- [ ] Navigate to weather value, Up/Down — no-op (read-only)
- [ ] `London weekly _` — does NOT trigger (no weather/forecast keyword)

## Hot-reload

- [ ] Edit `CUES.md` — changes take effect in ~2s without restart
- [ ] Edit `defaults/blanks/volume/BLANK.md` — changes take effect in ~2s without restart

## Prompt improver (consume-all blank)

### Auto-populate
- [ ] `improve prompt _` — keywords cleared, entire input replaced with improved prompt (multi-word span)
- [ ] Cursor lands at end of populated text
- [ ] Whole span dims gray

### Cycling alternatives
- [ ] Navigate to the first word of the span, Up/Down — cycles through 3 improved versions + original prompt
- [ ] Status line shows "Prompt improver" tip during cycling
- [ ] Each cycle replaces the entire span (not just the first word)

### Cleanup: typing over the span
- [ ] After span is populated, delete it and type `hello my name is` — no stale span
- [ ] Navigate to `hello` — shows grammar alternatives (e.g. "hi", "hey"), NOT prompt improver alternatives
- [ ] Status line tip is empty or shows grammar tip, NOT "Prompt improver"
- [ ] Same check after navigating away first (deactivating highlight), THEN typing — same result

### Cleanup: opencues settings
- [ ] `opencues settings _` → resolves to `voice-mode active`
- [ ] Delete entire text, type `hello my name is`
- [ ] Navigate to `hello` — shows grammar alternatives, NOT selector/satellite alts
- [ ] Status line tip is empty, NOT a settings tip

## Edge cases

- [ ] Type `_` alone — stays as `_` (no keyword binding, fluid-blank P1 bails on lone underscore)
- [ ] Very long input with `volume _` at the end — still works
- [ ] Rapid cycling (hold Up) — volume changes smoothly, no errors
