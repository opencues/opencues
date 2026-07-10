<#
  Drive the OpenCues TSF TIP over its pipe - the production path the WSL daemon
  will use (no keypress). Finds the FOREGROUND app, connects to that app's TIP
  pipe (\\.\pipe\opencues-tsf-<pid>), sends a SETTEXT command to replace the
  focused field, and reports the reply + round-trip latency (kill-question Q3).

  Prereq: the TIP is installed (register-tsf.ps1) and ACTIVE in the target app.

  Usage - focus Discord's message box (type something), then:
    powershell -ExecutionPolicy Bypass -File tsf-drive.ps1
    powershell -ExecutionPolicy Bypass -File tsf-drive.ps1 -Text "custom text"
    powershell -ExecutionPolicy Bypass -File tsf-drive.ps1 -Repeat 20   # latency sample
#>
param(
  [string] $Text = "",
  [int]    $Repeat = 1
)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System; using System.Runtime.InteropServices;
public static class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
}
"@

$fg = [FG]::GetForegroundWindow()
$tpid = 0
[void][FG]::GetWindowThreadProcessId($fg, [ref]$tpid)
$proc = try { (Get-Process -Id $tpid).ProcessName } catch { "?" }
$pipeName = "opencues-tsf-$tpid"
Write-Host "foreground: $proc (pid $tpid) -> pipe \\.\pipe\$pipeName"

$times = @()
for ($i = 0; $i -lt $Repeat; $i++) {
  $msg = if ($Text) { $Text } else { "[OpenCues TSF via pipe #$i @ $(Get-Date -Format HH:mm:ss.fff)]" }
  $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
  try { $client.Connect(1000) }
  catch { Write-Host "  connect failed - is 'OpenCues TSF' the ACTIVE input method in this app? ($($_.Exception.Message))"; $client.Dispose(); return }
  $payload = [System.Text.Encoding]::UTF8.GetBytes("SETTEXT`n$msg")
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $client.Write($payload, 0, $payload.Length)
  $client.Flush()
  $buf = New-Object byte[] 128
  $read = $client.Read($buf, 0, $buf.Length)
  $sw.Stop()
  $reply = [System.Text.Encoding]::ASCII.GetString($buf, 0, $read).Trim()
  $times += $sw.ElapsedMilliseconds
  Write-Host ("  #{0} reply='{1}' round-trip={2}ms" -f $i, $reply, $sw.ElapsedMilliseconds)
  $client.Dispose()
  if ($Repeat -gt 1) { Start-Sleep -Milliseconds 120 }   # ~animation cadence
}
if ($Repeat -gt 1) {
  $avg = ($times | Measure-Object -Average).Average
  $max = ($times | Measure-Object -Maximum).Maximum
  Write-Host ("latency over {0}: avg={1:N1}ms max={2}ms  (animation frame budget is ~75ms)" -f $Repeat, $avg, $max)
}
Write-Host ""
Write-Host "Look at the field: was it replaced FLASH-FREE, editor still healthy? That + the latency answers Q3."
