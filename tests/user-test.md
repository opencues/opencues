# User Tests

Manual sanity checks for the OpenCues system. Run after any code change + restart.

---

## Cues (word alternatives)

- [ ] Type `the happy dog` — words dim after ~500ms
- [ ] Navigate to a dimmed word (Ctrl+Alt+Left/Right) — highlights bold white
- [ ] Ctrl+Alt+Up/Down — cycles through alternatives
- [ ] Escape — clears highlight

## Step controls

- [ ] Type `1.5f` — dimmed (dark gray), navigable
- [ ] Navigate to it, Up — `2f`, Up — `2.5f`, Up — `3f` (step 0.5)
- [ ] Down back to `0f` — floors at 0 (`stepMin`)
- [ ] Plain numbers (`42`, `1.5`) should NOT dim or be navigable (no hardcoded number stepping)

## Blanks (fill-in-the-blank)

- [ ] `2 + 2 = _` — fills with `4` (math mode)
- [ ] `capital of France is _` — fills with `Paris` (factual mode)
- [ ] `The _ dog` — fills with grammar alternatives (big, small, brown)

## Cue-controls (word-based)

- [ ] Type `volume` — navigate to it, shows tip "system volume control"
- [ ] Up/Down — actual volume changes, Windows OSD appears
- [ ] TTS speaks the tip (if `speak: true` in config)

## Control-bound blanks

### Auto-populate
- [ ] `volume _` — `_` replaced with actual system volume number
- [ ] Number is dimmed (gray)
- [ ] Status line empty (no `blankTip` set)

### Cycling
- [ ] Navigate to the number, Up — increases by 6, actual volume changes
- [ ] Down — decreases by 6, actual volume changes
- [ ] Displayed number matches actual system volume

### Keywords + proximity
- [ ] `volume _` — matches (adjacent, proximity 0)
- [ ] `audio _` — matches ("audio" keyword)
- [ ] `sound _` — matches ("sound" keyword)
- [ ] `volume is _` — does NOT match (1 word gap exceeds proximity 0)

### Fresh value
- [ ] Type `volume _`, let it populate
- [ ] Clear input, type `volume _` again — gets fresh value, not cached

### Ownership model
- [ ] `volume _` populates with e.g. "64"
- [ ] Delete "64", type `hello` — "hello" gets normal grammar alts, NOT stuck as control-blank
- [ ] Clear entire input — no ghost control-blank positions
- [ ] Type `the happy dog` — normal behaviour, no stale control-blank at any index

### Both controls in same input
- [ ] Type `volume _` — "volume" is word-control, number is blank-control
- [ ] Cycle "volume" — volume changes via key presses (OSD)
- [ ] Cycle the number — volume changes via exact set (no OSD)

## List controls

- [ ] `affirmation _` — blank auto-populates with "I am strong" (first value)
- [ ] Cursor moves to end of populated value
- [ ] Navigate to it — whole phrase highlighted as span
- [ ] Up/Down cycles: "I am brave" → "I am worthy" → "I am enough" → wraps
- [ ] Status line shows "Daily affirmations" (tip only, not the word)

## Read-only API controls (stocks)

- [ ] `Reddit Stock _` — blank auto-populates with RDDT stock price (requires `FINNHUB_API_KEY`)
- [ ] `NVDA _` — blank auto-populates with NVIDIA stock price
- [ ] Navigate to the price, Up/Down — no-op (read-only, no change)
- [ ] Status line shows "Stock price"
- [ ] Without `FINNHUB_API_KEY` — blank stays as `_` (graceful degradation)

## Read-only API controls (weather)

- [ ] `London weather _` — blank auto-populates with current London weather (no API key needed)
- [ ] `Tokyo forecast tomorrow _` — tomorrow's Tokyo forecast
- [ ] `Uganda forecast weekend _` — weekend forecast for Uganda
- [ ] `Kenya forecast weekly _` — 7-day forecast
- [ ] `weather _` — defaults to London
- [ ] Navigate to weather value, Up/Down — no-op (read-only)
- [ ] `London weekly _` — does NOT trigger (no weather/forecast keyword)

## Hot-reload

- [ ] Edit `cues.md` — changes take effect in ~2s without restart
- [ ] Edit `controls/volume/cue.md` — changes take effect in ~2s without restart

## Edge cases

- [ ] Type `_` alone — should trigger blanks (grammar mode), NOT control-blank
- [ ] Very long input with `volume _` at the end — still works
- [ ] Rapid cycling (hold Up) — volume changes smoothly, no errors
