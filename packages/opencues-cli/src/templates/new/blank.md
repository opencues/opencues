---
# ─────────────────────────────────────────────────────────────────────
# Blank: {{NAME}}
# Created by `opencues new blank {{NAME}}`.
# ─────────────────────────────────────────────────────────────────────
#
# A folder-based blank. Pick ONE shape below by uncommenting the
# relevant block and deleting the rest. Colocate any scripts in this
# same folder (e.g. ./{{NAME}}.sh) and reference with a relative path.
#
# Real shipped examples (cat any to see the pattern in production):
#   defaults/blanks/volume/cue.md         — SHAPE 5: word + typed blank combined
#   defaults/blanks/brightness/cue.md     — SHAPE 5: same pattern
#   defaults/blanks/affirmations/cue.md   — SHAPE 4: list (no script)
#   defaults/blanks/numbers/cue.md        — SHAPE 3: step
#   defaults/blanks/opencues/cue.md       — SHAPE 6: selector + satellite
#   defaults/blanks/stocks/cue.md         — SHAPE 7: runtime-class (TS)
#   defaults/blanks/weather/cue.md        — SHAPE 7: runtime-class
#   defaults/blanks/hackernews/cue.md     — SHAPE 7: runtime-class
#   defaults/blanks/prompt/cue.md         — SHAPE 7: runtime-class (consume-all)

name: {{NAME}}
type: control
control: {{NAME}}

# ─────────────────────────────────────────────────────────────────────
# SHAPE 1: Word-blank — cycling triggers external action
# ─────────────────────────────────────────────────────────────────────
# The word "{{NAME}}" in text becomes cyclable. Ctrl+Alt+Up/Down runs
# the script with the given args. Good for: pure system adjustments
# where the user types the word as a verb (less common — most useful
# blanks combine word + typed-blank, see SHAPE 5).
#
# Fields:
#   script:    path to script, relative to this cue.md
#   upArgs:    JSON array of args passed on Up-cycle
#   downArgs:  JSON array of args passed on Down-cycle
#   tip:       statusline tip when the word is highlighted
#   speak:     bool — read tip via TTS on navigation (default false)

# tip: "{{NAME}} blank"
# speak: false
# script: ./{{NAME}}.sh
# upArgs: ["up", "5"]
# downArgs: ["down", "5"]

# ─────────────────────────────────────────────────────────────────────
# SHAPE 2: Typed blank — typing `_` near keyword auto-populates
# ─────────────────────────────────────────────────────────────────────
# When the user types `_` within `blankProximity` words of a keyword,
# the runtime calls `blankScript get` to read the current value, fills
# the blank, then calls `blankScript set <value>` on cycle. Good for:
# typed-blanks without a corresponding word-blank (rare).
#
# Fields (all optional except blankKeywords + blankScript):
#   blankKeywords:        comma-separated triggers (required)
#   blankScript:          script that responds to `get` / `set <value>`
#                         (required for live-value blanks; alternative:
#                         stepValues for static lists — see SHAPE 4)
#   blankAutoPopulate:    fill `_` immediately on typing (default false;
#                         most live-value blanks want true)
#   blankFormat:          integer | float | string  (default string)
#   blankSuffix:          appended to numeric display (e.g. "%", "px")
#   blankStep:            step size for cycling (numeric blanks only)
#   blankReadOnly:        disable cycling — use for live API data
#                         where the user just wants to read (stocks)
#   blankDismissible:     allow `_` to be cleared to nothing (default false)
#   blankProximity:       max words between keyword + `_` (default 0 = adjacent)
#   blankTip:             statusline tip when the blank is highlighted

# blankKeywords: {{NAME}}
# blankAutoPopulate: true
# blankFormat: string
# blankTip: "{{NAME}} value"
# blankProximity: 0
# blankScript: ./{{NAME}}-blank.sh

# ─────────────────────────────────────────────────────────────────────
# SHAPE 3: Step blank — numeric cycling, no script
# ─────────────────────────────────────────────────────────────────────
# Cycles numeric values with suffixes (e.g. "8.5f" → "9.0f" → "9.5f").
# No script needed; runtime handles the arithmetic. See defaults/
# blanks/numbers/cue.md for production example.
#
# Fields (use stepPattern OR stepSuffixes, not both):
#   stepPattern:   regex with captures — (\d+)(px|em|rem)
#   stepSuffixes:  space-separated list — "px em rem %"
#   step:          increment (default 1)
#   stepMin:       lower bound (optional)
#   stepMax:       upper bound (optional)
#   stepFormat:    integer | float (default integer)
#   stepTip:       tip shown when a cyclable value is highlighted

# stepSuffixes: f
# step: 0.5
# stepMin: 0
# stepFormat: float
# stepTip: "±0.5{{NAME}}"

# ─────────────────────────────────────────────────────────────────────
# SHAPE 4: List blank — cycles a fixed list on a typed-blank position
# ─────────────────────────────────────────────────────────────────────
# Combines a typed-blank keyword trigger with a fixed cycle list.
# No script needed. See defaults/blanks/affirmations/cue.md.
#
# Fields:
#   blankKeywords:    comma-separated triggers
#   stepValues:       JSON array of strings to cycle through
#   tip:              statusline tip on highlight
#   blankDismissible: allow clearing (default false; affirmations uses true)

# blankKeywords: {{NAME}}
# stepValues: ["first", "second", "third"]
# tip: "{{NAME}} options"
# blankDismissible: true

# ─────────────────────────────────────────────────────────────────────
# SHAPE 5: COMBINED word + typed blank (most powerful — volume/brightness)
# ─────────────────────────────────────────────────────────────────────
# Both word-blank AND typed-blank on the same cue.md. The word
# itself cycles via key presses (script:); typing `_` near the keyword
# auto-populates with the live value AND lets you cycle that value
# precisely (blankScript:). The two scripts share the same colocated
# helper binary (e.g. VolCtl.exe). See defaults/blanks/volume/cue.md.

# tip: system {{NAME}} blank
# speak: true
# script: ./{{NAME}}.sh
# upArgs: ["up", "5"]
# downArgs: ["down", "5"]
# blankKeywords: {{NAME}}
# blankAutoPopulate: true
# blankFormat: integer
# blankSuffix: %
# blankStep: 5
# blankScript: ./{{NAME}}-blank.sh

# ─────────────────────────────────────────────────────────────────────
# SHAPE 6: Selector + Satellite (opencues settings pattern)
# ─────────────────────────────────────────────────────────────────────
# Two-word span: typing `<keyword> _` expands to `<setting-name> <value>`.
# Cycle the SELECTOR (first word) to switch settings; cycle the
# SATELLITE (second word) to change the current setting's value. Used
# by the opencues blank for runtime settings (voice-mode, debug-mode, etc.).
# See defaults/blanks/opencues/cue.md.
#
# Extra fields:
#   blankSatellite:           true — enable selector+satellite shape
#   blankSatelliteSeparator:  string between selector+satellite (default ' ')
#   blankClearKeywords:       remove the trigger keywords from text
#                             after expansion (true = clean output)
#   blankClearOnEdit:         drop the satellite if user types over the
#                             selector (true = matched-pair cleanup)

# blankKeywords: opencues settings, config
# blankAutoPopulate: true
# blankFormat: string
# blankScript: ./{{NAME}}-blank.sh
# blankSatellite: true
# blankSatelliteSeparator: ' '
# blankClearKeywords: true
# blankClearOnEdit: true

# ─────────────────────────────────────────────────────────────────────
# SHAPE 7: Runtime-class blank (LLM/HTTP-backed — stocks, weather, etc.)
# ─────────────────────────────────────────────────────────────────────
# For blanks backed by an LLM call, HTTP API, or any host-runtime
# logic, do NOT write a script — implement a TS class instead:
#   1. packages/opencues-runtime/src/controls/{{NAME}}.ts (extends Control)
#   2. Register in each host's controlInvoke map (see opencuesRuntime.ts
#      for CC, opencuesBootstrap.ts for OC, controls/index.ts for chrome)
#   3. cue.md declares blankKeywords + blankReadOnly + blankFormat —
#      no script: or blankScript: at all.
#
# See defaults/blanks/stocks/cue.md (real-world: 7 ticker keyword
# expansions, blankReadOnly: true so cycling is no-op, all dispatch
# happens in StocksControl in TS).
#
# Bonus: blankKeywordExpansions.<keyword>: <expansion> — replaces the
# matched trigger word with a friendlier display name. e.g. typing
# "rddt _" with `blankKeywordExpansions.rddt: Reddit` produces
# "Reddit $133.44". One entry per keyword.

# blankKeywords: rddt, nvda, aapl
# blankAutoPopulate: true
# blankFormat: string
# blankTip: Stock price
# blankReadOnly: true
# blankProximity: 1
# blankKeywordExpansions.rddt: Reddit
# blankKeywordExpansions.nvda: Nvidia
# blankKeywordExpansions.aapl: Apple

# ─────────────────────────────────────────────────────────────────────
# HOST COMPATIBILITY (advanced)
# ─────────────────────────────────────────────────────────────────────
# Auto-detect: if `script:` or `blankScript:` ends in .sh / .ps1 / .bat
# / .exe / etc., this blank is excluded from chrome (browsers can't
# spawn subprocesses).
#
# Override:
#   on-host:     [chrome, ...]   — allow-list (replaces auto-detect)
#   not-on-host: [chrome]        — deny-list (filters auto / on-host)
#
# Use `on-host:` if you have a runtime-class implementation in
# @opencues/runtime/src/controls/<name>.ts that handles chrome (e.g.
# routes through chrome.storage instead of the .sh fallback). The
# opencues blank does this — `blankScript: ./opencues-blank.sh` for
# native hosts, OpenCuesSettingsControl in TS for chrome, and
# `on-host: chrome, claude-code, codex, opencode` to override the
# auto-detect that would otherwise exclude chrome.
# See docs/features/host-compat.md.

# on-host: chrome, claude-code, codex, opencode
# not-on-host: chrome
---
