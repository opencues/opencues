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
  [ValidateSet('SETTEXT','GETTEXT','GETCARET','SETCARET')]
  [string] $Op = 'SETTEXT',
  [string] $Text = "",      # SETTEXT body
  [string] $Caret = "end",  # SETCARET target: "end" or an integer offset
  [int]    $Repeat = 1,
  [int]    $DelaySec = 0     # wait before reading the foreground window, so the
                             # driver can be launched hidden while you focus the
                             # target app (a terminal would otherwise be foreground)
)
$ErrorActionPreference = 'Stop'
if ($DelaySec -gt 0) { Start-Sleep -Seconds $DelaySec }

function Send-OcCommand($pipeName, $bytes) {
  $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
  try { $client.Connect(1000) }
  catch { return @{ ok = $false; err = $_.Exception.Message } }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $client.Write($bytes, 0, $bytes.Length)
  $client.Flush()
  $buf = New-Object byte[] 70000
  $read = $client.Read($buf, 0, $buf.Length)
  $sw.Stop()
  $client.Dispose()
  return @{ ok = $true; reply = [System.Text.Encoding]::UTF8.GetString($buf, 0, $read); ms = $sw.ElapsedMilliseconds }
}

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
  switch ($Op) {
    'SETTEXT'  { $body = if ($Text) { $Text } else { "[OpenCues TSF via pipe #$i @ $(Get-Date -Format HH:mm:ss.fff)]" }
                 $frame = "SETTEXT`n$body" }
    'GETTEXT'  { $frame = "GETTEXT`n" }
    'GETCARET' { $frame = "GETCARET`n" }
    'SETCARET' { $frame = "SETCARET`n$Caret" }
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($frame)
  $r = Send-OcCommand $pipeName $bytes
  if (-not $r.ok) { Write-Host "  connect failed - is 'OpenCues TSF' the ACTIVE input method in this app? ($($r.err))"; return }
  $reply = ($r.reply -replace "`r", '')
  $first = ($reply -split "`n")[0]
  $times += $r.ms
  if ($Op -eq 'GETTEXT') {
    $text = $reply.Substring($reply.IndexOf("`n") + 1)
    Write-Host ("  #{0} {1}  round-trip={2}ms  text='{3}'" -f $i, $first, $r.ms, ($text -replace "`n", ' '))
  } else {
    Write-Host ("  #{0} reply='{1}' round-trip={2}ms" -f $i, $first, $r.ms)
  }
  if ($Repeat -gt 1) { Start-Sleep -Milliseconds 120 }   # ~animation cadence
}
if ($Repeat -gt 1) {
  $avg = ($times | Measure-Object -Average).Average
  $max = ($times | Measure-Object -Maximum).Maximum
  Write-Host ("latency over {0}: avg={1:N1}ms max={2}ms  (animation frame budget is ~75ms)" -f $Repeat, $avg, $max)
}
Write-Host ""
Write-Host "For SETTEXT: was the field replaced FLASH-FREE, editor healthy? That + latency answers Q3."
