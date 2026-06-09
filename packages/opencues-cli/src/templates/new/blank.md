---
# ─────────────────────────────────────────────────────────────────────
# Blank: {{NAME}}
# Created by `opencues new blank {{NAME}}`.
# ─────────────────────────────────────────────────────────────────────
#
# A blank is a `_`-triggered slot. The user types your keyword followed
# by `_`, and your script / runtime class fills the slot with a value.
# Pick ONE shape below by uncommenting its block and deleting the rest.
# Colocate any scripts in this same folder (e.g. ./{{NAME}}-blank.sh)
# and reference with a relative path.
#
# Real shipped examples (cat any to see the pattern in production):
#   defaults/blanks/volume/BLANK.md         — SHAPE 1: typed blank + script
#   defaults/blanks/brightness/BLANK.md     — SHAPE 1: same pattern
#   defaults/blanks/affirmations/BLANK.md   — SHAPE 2: list (no script)
#   defaults/blanks/opencues/BLANK.md       — SHAPE 3: selector + satellite
#   defaults/blanks/stocks/BLANK.md         — SHAPE 4: runtime-class (TS)
#   defaults/blanks/weather/BLANK.md        — SHAPE 4: runtime-class
#   defaults/blanks/hackernews/BLANK.md     — SHAPE 4: runtime-class
#   defaults/blanks/prompt/BLANK.md         — SHAPE 4: runtime-class (consume-all)

name: {{NAME}}
type: blank

# ─────────────────────────────────────────────────────────────────────
# SHAPE 1: Typed blank — typing `_` near keyword auto-populates
# ─────────────────────────────────────────────────────────────────────
# When the user types `_` within `blankProximity` words of a keyword,
# the runtime calls `blankScript get` to read the current value, fills
# the blank, then calls `blankScript set <value>` on cycle. Good for:
# system state (volume, brightness) and read-only API lookups.
#
# Fields (all optional except blankKeywords + blankScript):
#   blankKeywords:        comma-separated triggers (required)
#   blankScript:          script that responds to `get` / `set <value>`
#                         (required for live-value blanks; alternative:
#                         stepValues for static lists — see SHAPE 2)
#   blankAutoPopulate:    fill `_` immediately on typing (default false;
#                         most live-value blanks want true)
#   blankFormat:          integer | float | string  (default string)
#   blankSuffix:          appended to numeric display (e.g. "%", "px")
#   blankStep:            step size for cycling (numeric blanks only)
#   blankReadOnly:        disable cycling — use for live API data
#   blankTip:             statusline tip when the blank is highlighted
#   blankProximity:       words-distance from keyword to `_` (default 5)

# blankKeywords: {{NAME}}
# blankScript: ./{{NAME}}-blank.sh
# blankAutoPopulate: true
# blankFormat: integer
# blankSuffix: %
# blankStep: 5
# blankTip: "system {{NAME}}"

# ─────────────────────────────────────────────────────────────────────
# SHAPE 2: List blank — cycles a fixed list (no script)
# ─────────────────────────────────────────────────────────────────────
# Combines a typed-blank keyword trigger with a fixed cycle list.
# No script needed. See defaults/blanks/affirmations/BLANK.md.
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
# SHAPE 3: Selector + Satellite (opencues settings pattern)
# ─────────────────────────────────────────────────────────────────────
# Two-word span: typing `<keyword> _` expands to `<setting-name> <value>`.
# Cycle the SELECTOR (first word) to switch settings; cycle the
# SATELLITE (second word) to change the current setting's value. Used
# by the opencues blank for runtime settings (voice-mode, debug-mode, etc.).
# See defaults/blanks/opencues/BLANK.md.
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
# SHAPE 4: Runtime-class blank (LLM/HTTP-backed — stocks, weather, etc.)
# ─────────────────────────────────────────────────────────────────────
# For blanks backed by an LLM call, HTTP API, or any host-runtime
# logic, do NOT write a script — implement a TS class instead:
#   1. packages/opencues-runtime/src/blanks/{{NAME}}.ts (implements Blank)
#   2. Register in each host's blanksRegistry (see opencues-bootstrap.ts
#      for OC, blanks/index.ts for chrome)
#   3. cue.md declares blankKeywords + blankReadOnly + blankFormat —
#      no blankScript: at all.
#
# See defaults/blanks/stocks/BLANK.md (real-world: 7 ticker keyword
# expansions, blankReadOnly: true so cycling is no-op, all dispatch
# happens in StocksBlank in TS).
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
# Auto-detect: if `blankScript:` ends in .sh / .ps1 / .bat / .exe etc.,
# this blank is excluded from chrome (browsers can't spawn subprocesses).
#
# Override:
#   on-host:     [chrome, ...]   — allow-list (replaces auto-detect)
#   not-on-host: [chrome]        — deny-list (filters auto / on-host)
#
# Use `on-host:` if you have a runtime-class implementation in
# @opencues/runtime/src/blanks/<name>.ts wired into BUILTIN_BLANKS.
# The opencues + sentinel blanks do this — no `blankScript:` field at
# all; OpenCuesSettingsBlank / SentinelBlank serve every host via
# blankInvoke (chrome.storage on chrome, fs-backed readFile/writeFile
# on native hosts). See docs/features/host-compat.md.

# on-host: chrome, claude-code, gemini-cli, opencode
# not-on-host: chrome
---
