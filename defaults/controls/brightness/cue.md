---
name: brightness
type: control
control: brightness
tip: screen brightness
speak: true
script: ./brightness.sh
upArgs: ["up", "10"]
downArgs: ["down", "10"]
blankKeywords: brightness, bright, screen, display
blankStep: 10
blankAutoPopulate: true
blankSuffix: %
blankScript: ./brightness-blank.sh
---
