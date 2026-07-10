# OpenCues TSF spike

A minimal **Text Services Framework** text service (TIP), built to answer one
question empirically: **can a TSF range write replace text in Discord's Slate
editor with no flash and no ghost?** — the one write path that, if it works,
removes the last cosmetic wart on the Windows host and unlocks event-driven
reads/caret/keys for phase 2. See `../../research/tsf-spike.md` for the full
rationale, capability table, and install analysis.

**Status: research spike. Not wired into the shim, not shipped, opt-in only.**

## Files

| File | What |
|---|---|
| `opencues-tsf.cpp` | the TIP — COM DLL, `ITfTextInputProcessor` + `ITfKeyEventSink`, preserves **Ctrl+Alt+J**, and on that key replaces the focused document via `ITfRange::SetText` |
| `opencues-tsf.def` | export list (`DllGetClassObject` / `DllCanUnloadNow` / `DllRegisterServer` / `DllUnregisterServer`) |
| `build-tsf.sh` | mingw-w64 cross-compile from WSL → `opencues-tsf.dll` (x64) |
| `register-tsf.ps1` | self-elevating install (copy DLL, `regsvr32`, enable+activate profile) |
| `unregister-tsf.ps1` | self-elevating full uninstall |

## Run it

```bash
# 1. build (WSL)
integrations/windows/native/tsf/build-tsf.sh
```
```powershell
# 2. install (Windows PowerShell — ONE UAC prompt)
powershell -ExecutionPolicy Bypass -File register-tsf.ps1
```
3. If "OpenCues TSF (spike)" isn't already the active input method, **Win+Space** → pick it.
4. Click into **Discord**'s message box, type `hello world`, press **Ctrl+Alt+J**.
5. Observe — the three kill-questions:
   - **Q2 (the point):** did the text get *replaced* with the marker, **flash-free**, and is the composer still typeable afterward (no ghost)?
   - **Q1:** did step 3 require a manual Win+Space, or did `register-tsf.ps1` activate it silently?
   - Latency/behaviour notes → `\\wsl.localhost\Ubuntu\tmp\oc-tsf.log`.
```powershell
# 6. uninstall
powershell -ExecutionPolicy Bypass -File unregister-tsf.ps1
```

## Safety / revert

- The DLL loads **into every app you focus** while active — this is what a TIP
  *is*. It only acts on Ctrl+Alt+J; all other keys pass through untouched.
- If anything misbehaves: switch input method away (Win+Space), then
  `unregister-tsf.ps1`. The DLL frees on next sign-out/reboot.
- The entire spike is git-revertable — every file here is after the branch's
  spike-anchor commit; `git revert` that range (or reset to it) erases it.
