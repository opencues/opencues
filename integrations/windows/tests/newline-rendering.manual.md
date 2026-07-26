# Manual test — newline rendering matches Notepad across editors

**Why manual:** the shim's newline handling is Add-Type-compiled C# and its
effect is *visual rendering inside the target app*, so it can't be asserted by
an automated test on Linux/CI. The source-level regression guard is
`newline-invariants.mjs` (run `node integrations/windows/tests/newline-invariants.mjs`);
this file is the behavioral check a human runs. Background:
`../IMPLEMENTATION.md` § "Newline rendering".

## Setup

1. Bring up a clean singleton: `integrations/windows/bin/oc-windows-reset`.
2. Confirm it's live: `grep 'shim connected to daemon' /tmp/opencues.log | tail -1`.
3. Watch the write path while testing:
   `tail -f /tmp/opencues.log | grep -E 'attached:|TSF|EM_REPLACESEL|paste|ValuePattern'`.

## The fixture

Type `draft an email _` in each app and let it resolve. The runtime emits a
sectioned email whose top sections are separated by a blank line (`\n\n`) and
whose **signature block is single-`\n` adjacent lines** (name / title / company /
email / phone / links). **Notepad is the reference** — open it in Notepad too and
compare.

## Pass criteria (each app must match Notepad)

- [ ] **Notepad** — sections separated by one blank line; signature lines
      adjacent (no gaps). (Reference.)
- [ ] **WordPad** — identical to Notepad: one blank line between sections, the
      signature block **adjacent** (not double-spaced, no paragraph gaps).
      Log shows `EM_REPLACESEL final`.
- [ ] **Slack** — identical to Notepad: signature lines **adjacent**, one blank
      line between sections. Log shows `paste [Slack soft-break]`. A single
      select-all highlight on the final write is expected; the spinner frames
      before it do not flash.
- [ ] **Discord** — identical to Notepad (already correct via its MSAA paste
      path). Log shows `MSAA/paste`.

## Regressions this catches (all were real)

- WordPad **double-spaced** everything → the `\n`→VT soft-break conversion isn't
  running (check the richedit class test is case-insensitive) or `\n\n` is being
  collapsed.
- Slack puts a **blank line between every signature row** → the final write is on
  `SetValue`, not paste (`PastePreferredApps` lost `slack`).
- Any app **loses its blank lines** (sections run together) → the retired
  `\n\n` collapse came back.
- A fill **re-resolves itself / loops** on a multi-line write → `EolNorm` stopped
  folding a break form (VT / U+2028), so the soft-break read-back no longer
  matches the write.
