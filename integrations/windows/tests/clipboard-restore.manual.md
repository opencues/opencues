# Clipboard-restore + stale-model manual checklist (Windows-side)

Companion to `clipboard-invariants.mjs` (which pins the SOURCE shapes on
any OS). These are the visual/behavioural checks only a real Windows
session can run — the pattern mirrors `newline-rendering.manual.md`.
Origin: the 2026-07-14 incident pair (a copied email address pasted
into Discord instead of the substitution; typed "congratulations"
losing its leading "con" mid-animation).

Run after any change to `PasteReplace`, `TryTypeMicroEdit`,
`TryReadCurrentField`, or the clipboard helpers. Restart the tray first
(the shim is Add-Type-compiled at launch).

## 1. Clipboard leak (the one that matters)

1. Copy a marker string: `CANARY123`.
2. In Discord, trigger a big substitution:
   `write a congratz message for discord _`
3. PASS: the substitution lands AND pasting somewhere neutral yields
   `CANARY123` — with `clipboard restored after verified paste
   consumption` in `/tmp/opencues.log`.
4. ACCEPTABLE (fail-safe): the substitution lands, the log warns
   `clipboard NOT restored`, and the clipboard holds the substitution
   text. If this happens EVERY time in an app, the consumption match is
   too strict for that app's readback dress — extend the AlnumFold
   fallback, never the timeout alone.
5. FAIL (the leak): `CANARY123` appears IN THE FIELD instead of the
   substitution. This must be impossible; if seen, the restore is
   racing the paste again.

## 2. Eaten keystrokes

1. Trigger any blank and, while its loading animation is running,
   immediately type a new command without pausing:
   `congratulations letter _`
2. PASS: every typed character survives (watch the daemon's
   `resolveAndApply` lines — the text must start `congratulations`,
   not `gratulations`). `micro-frame skipped: field diverged` lines in
   the log are the guard working, not a failure.

## 3. Restore actually happens (anti-lossiness)

After several large substitutions across the app matrix (Discord,
Slack, Notepad, WordPad), `grep -c 'clipboard restored after verified'
/tmp/opencues.log` should roughly match the substitution count, with
only occasional `clipboard NOT restored` warns. A 100% warn rate in
any app = the consumption match never fires there; catalog the app's
readback dress and extend the fold.
