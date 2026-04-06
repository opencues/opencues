---
name: volume
type: control
control: volume
tip: system volume control
speak: true
script: ./volume.sh
upArgs: ["up", "6"]
downArgs: ["down", "6"]
blankKeywords: volume, vol, sound, audio
blankStep: 6
blankAutoPopulate: true
blankScript: ./volume-blank.sh
---
