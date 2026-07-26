' OpenCues tray - hidden launcher.
'
' Starts OpenCuesTray.ps1 with NO console window (WScript.Shell.Run with
' intWindowStyle=0). Used as the HKCU\...\Run autostart target so login
' launch never flashes a terminal. Self-locating: resolves the .ps1 next
' to this script, so the whole native/ folder can move without edits.

Dim fso, here, ps1, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(here, "OpenCuesTray.ps1")

cmd = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
CreateObject("WScript.Shell").Run cmd, 0, False
