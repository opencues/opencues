---
# ─────────────────────────────────────────────────────────────────────
# Blank: {{NAME}}
# Created by `opencues new blank {{NAME}}`.
# ─────────────────────────────────────────────────────────────────────
#
# A blank is a `_`-triggered slot. The user types a command whose keyword
# LEADS the line ending in `_` (e.g. `{{NAME}} _`, `{{NAME}} paris _`),
# and your script / runtime class fills the slot with a value.
# Pick ONE shape below by uncommenting its block and deleting the rest.
# Colocate any scripts in this same folder (e.g. ./{{NAME}}-blank.sh)
# and reference with a relative path.
#
# Routing is DETERMINISTIC and line-scoped: `blankKeywords` desugar into
# anchored `blankShapes` (a get shape, plus set/step shapes when
# `blankStep` is present). The keyword must lead its line with `_` at the
# trailing edge — prose that merely mentions a keyword mid-line never
# fires. Authoring `blankShapes:` explicitly overrides the synthesized
# grammar (see SHAPE 5).
#
# Real shipped examples (cat any to see the pattern in production):
#   defaults/blanks/volume/BLANK.md         — SHAPE 1: typed blank + script
#   defaults/blanks/brightness/BLANK.md     — SHAPE 1: same pattern
#   defaults/blanks/affirmations/BLANK.md   — SHAPE 2: list (no script)
#   defaults/blanks/opencues/BLANK.md       — SHAPE 3: selector + satellite
#   defaults/blanks/stocks/BLANK.md         — SHAPE 4: runtime-class (TS)
#   defaults/blanks/weather/BLANK.md        — SHAPE 4: runtime-class
#   defaults/blanks/hackernews/BLANK.md     — SHAPE 4: runtime-class

name: {{NAME}}
type: blank

# ─────────────────────────────────────────────────────────────────────
# SHAPE 1: Typed blank — keyword leads the line, `_` auto-populates
# ─────────────────────────────────────────────────────────────────────
# When the user types `{{NAME}} _` (keyword leading the line), the runtime
# calls `blankScript get` to read the current value and fills the blank.
# Declare `blankStep` to make it cycleable: Up/Down then steps the value
# and calls `blankScript set <value>`. Typed commands work too — `{{NAME}}
# 30 _` (set) and `{{NAME}} up _` (step). Good for: system state (volume,
# brightness) and read-only API lookups.
#
# Auto-populate is automatic — any shape match fills the `_`. Cycleability
# is INFERRED: a blank cycles only if it declares blankStep / stepValues /
# blankSatellite; otherwise it's read-only by construction (no flag).
#
# Fields (all optional except blankKeywords + blankScript):
#   blankKeywords:  comma-separated triggers (required — desugar to shapes)
#   blankScript:    script that responds to `get` / `set <value>` / `up` /
#                   `down` (required for live-value blanks; alternative:
#                   stepValues for static lists — see SHAPE 2)
#   blankStep:      step size for numeric cycling. Its presence makes the
#                   blank settable (synthesizes set/step shapes) and marks
#                   it cycleable. Float precision is taken from the step.
#   blankSuffix:    appended to numeric display (e.g. "%", "px")
#   tip:            statusline tip when the blank is highlighted
#   integration:    additive output template with a {value} slot, e.g.
#                   "{{NAME}} is now {value}" (shapes the inserted value
#                   only — never deletes surrounding text)

# blankKeywords: {{NAME}}
# blankScript: ./{{NAME}}-blank.sh
# blankSuffix: %
# blankStep: 5
# tip: "system {{NAME}}"

# ─────────────────────────────────────────────────────────────────────
# SHAPE 2: List blank — cycles a fixed list (no script)
# ─────────────────────────────────────────────────────────────────────
# Combines a keyword trigger with a fixed cycle list. No script needed.
# See defaults/blanks/affirmations/BLANK.md.
#
# Fields:
#   blankKeywords:    comma-separated triggers
#   stepValues:       JSON array of strings to cycle through (cycleable)
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
# `blankSatellite: true` makes the blank cycleable. See
# defaults/blanks/opencues/BLANK.md.
#
# Extra fields:
#   blankSatellite:           true — enable selector+satellite shape
#   blankSatelliteSeparator:  string between selector+satellite (default ' ')
#   blankClearKeywords:       remove the trigger keywords from text
#                             after expansion (true = clean output)
#   blankClearOnEdit:         drop the satellite if user types over the
#                             selector (true = matched-pair cleanup)

# blankKeywords: opencues settings, config
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
#   3. BLANK.md declares blankKeywords + impl — no blankScript: at all.
#      Omit blankStep / stepValues / blankSatellite and the blank is
#      read-only (fetch once, no cycling) — inferred, not declared.
#
# See defaults/blanks/stocks/BLANK.md (real-world: ticker keywords, read-
# only, all dispatch happens in StocksBlank in TS).
#
# Display form: the blank's get() returns the exact string it wants shown
# (e.g. StocksBlank returns "Reddit $133.44", not bare "$133.44"). There
# is no keyword-rewrite knob — a blank owns its own presentation. Wrap it
# further with an `integration:` template if you want connective text.

# blankKeywords: rddt, nvda, aapl
# impl: '@opencues/runtime StocksBlank'
# tip: Stock price

# ─────────────────────────────────────────────────────────────────────
# SHAPE 5: Explicit blankShapes (advanced — custom routing grammar)
# ─────────────────────────────────────────────────────────────────────
# When the synthesized keyword grammar isn't enough, author the anchored
# shapes directly. Each shape is `{pattern, action, valueGroup?}`, matched
# (case-insensitive) against the LINE containing `_`. `action` is one of
# get / set / step; `valueGroup` is the 1-based capture group carrying the
# set/step value. Explicit shapes WIN over the keyword-synthesized grammar
# for runtime dispatch + cede, but `blankKeywords` is still required (the
# resolver's auto-populate/cycling path keys off it).

# blankKeywords: {{NAME}}
# blankScript: ./{{NAME}}-blank.sh
# blankShapes: [{"pattern":"^{{NAME}}\\s+(\\d+)\\s*_$","action":"set","valueGroup":1},{"pattern":"^{{NAME}}\\s*_$","action":"get"}]

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

# on-host: chrome, claude-code, gemini-cli, opencode, shell, vscode
# not-on-host: chrome
---
