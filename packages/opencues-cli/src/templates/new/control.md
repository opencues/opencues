---
name: {{NAME}}
type: control
control: {{NAME}}
# Cue-control: {{NAME}}
# Created by `opencues new control {{NAME}}`.
#
# Word-control fields (cycling triggers actions like volume up/down):
#   script: ./{{NAME}}.sh         — relative to this cue.md
#   upArgs: ["up", "5"]           — args passed when user cycles Up
#   downArgs: ["down", "5"]       — args passed when user cycles Down
#
# Blank-control fields (typing `_` after the keyword auto-populates):
#   blankKeywords: foo, bar       — words that activate blank-fill
#   blankAutoPopulate: true       — fill `_` immediately after typing it
#   blankFormat: number | string  — value type
#   blankReadOnly: true           — disable cycling (e.g., live API data)
#   blankScript: ./{{NAME}}-blank.sh   — script that returns the value
#
# For LLM/HTTP controls, implement as a TS class in
# packages/opencues-runtime/src/controls/ and register in each host's
# controlInvoke map. See docs/guides/adding-a-cue-control.md.
blankKeywords: {{NAME}}
blankAutoPopulate: true
blankFormat: string
---
