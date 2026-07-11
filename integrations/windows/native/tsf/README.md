# OpenCues TSF spike

A **Text Services Framework** text service (TIP). It began as a spike to answer
one question empirically — **can a TSF range write replace text in Discord's
Slate editor with no flash and no ghost?** (**answered: yes**, see
`../../research/tsf-spike.md`) — and has since grown into the production shape: a
**thin-proxy TIP** holding no OpenCues logic, driven by the WSL daemon (via the
Windows shim) over a per-process named pipe. It's the flash-free write path plus
event-driven reads/caret/text-change that unlock phase 2.

**Status: spike on `wip/windows-integration`. Once the TIP is installed the
shim uses it automatically (no mode to enable — installing it IS the opt-in;
kill switch `OPENCUES_TSF=0`). Not yet shipped; the whole subtree reverts to
the branch's spike-anchor commit.**

## Files

| File | What |
|---|---|
| `opencues-tsf.cpp` | the TIP — COM DLL. `ITfTextInputProcessor` + `ITfKeyEventSink` (preserves **Ctrl+Alt+J** as a manual replace-with-marker fallback) + `ITfThreadMgrEventSink` + `ITfTextEditSink`. Serves a per-PID command pipe `\\.\pipe\opencues-tsf-<pid>` and streams edit/focus events to a subscriber. |
| `opencues-tsf.def` | export list (`DllGetClassObject` / `DllCanUnloadNow` / `DllRegisterServer` / `DllUnregisterServer`) |
| `build-tsf.sh` | mingw-w64 cross-compile from WSL → `opencues-tsf.dll` (x64) |
| `register-tsf.ps1` | self-elevating install (copy DLL, `regsvr32`, enable+activate profile) |
| `unregister-tsf.ps1` | self-elevating full uninstall |
| `tsf-drive.ps1` | driver — connects to the foreground app's TIP pipe, sends `SETTEXT`/`GETTEXT`/`GETCARET`/`SETCARET`, times the round-trip (the daemon's production path, no keypress) |
| `tsf-events.ps1` | subscriber — sends `SUBSCRIBE`, prints the live event stream (`TEXTCHANGED` / `FOCUS` / `BLUR`) |

## Command & event protocol (over `\\.\pipe\opencues-tsf-<pid>`)

Byte pipe, newline-framed request `"<OP>\n<payload>"`, one command per
connection (except `SUBSCRIBE`, which is held open):

| Request | Payload | Reply |
|---|---|---|
| `SETTEXT` | utf-8 text | `OK hr=0x…` — replaces the whole focused doc via `ITfRange::SetText` (flash-free) |
| `GETTEXT` | — | `OK len=N\n<utf-8 text>` |
| `GETCARET` | — | `OK caret=N` (char offset, `-1` if none) |
| `SETCARET` | `end` or an integer | `OK hr=0x…` |
| `SUBSCRIBE` | — | `OK subscribed`, then a **held-open** stream of `"<TYPE>:<byteLen>\n<utf-8>"` event frames |

Event frames (M3/M4):

| Type | Body | When |
|---|---|---|
| `TEXTCHANGED` | the whole buffer | after every edit (`ITfTextEditSink::OnEndEdit`) |
| `FOCUS` | `<pid>\|<app>` | this TIP gained the focused editable doc — the subscriber now knows the pipe to drive |
| `BLUR` | *(empty)* | it lost the focused doc |

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
