<#
  Subscribe to the OpenCues TSF TIP's event stream (M3) and print events live.
  Connects to the FOREGROUND app's TIP pipe, sends SUBSCRIBE, then reads the
  length-framed event stream: TEXTCHANGED (the buffer after every edit) and
  FOCUS (focus moved). This is the event-driven read path that would let the
  daemon retire the 150ms UIA poll for TSF apps.

  Prereq: TIP installed + ACTIVE in the target app.

  Usage - focus the target app, then:
    powershell -ExecutionPolicy Bypass -File tsf-events.ps1
    powershell -ExecutionPolicy Bypass -File tsf-events.ps1 -DurationSec 60
  Or launched hidden with -DelaySec so you can focus the app after starting it.
#>
param(
  [int] $DelaySec = 0,
  [int] $DurationSec = 45
)
$ErrorActionPreference = 'Stop'
if ($DelaySec -gt 0) { Start-Sleep -Seconds $DelaySec }

Add-Type @"
using System; using System.Runtime.InteropServices;
public static class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
}
"@
$fg = [FG]::GetForegroundWindow(); $tpid = 0
[void][FG]::GetWindowThreadProcessId($fg, [ref]$tpid)
$proc = try { (Get-Process -Id $tpid).ProcessName } catch { "?" }
$pipeName = "opencues-tsf-$tpid"
$log = "\\wsl.localhost\Ubuntu\tmp\oc-tsf-events.log"
function Emit($m) { Write-Host $m; try { $m | Out-File -FilePath $log -Append -Encoding utf8 } catch {} }
try { "" | Out-File -FilePath $log -Encoding utf8 } catch {}
Emit "subscribing to $proc (pid $tpid) -> \\.\pipe\$pipeName"

$client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
try { $client.Connect(1500) }
catch { Emit "  connect failed - is 'OpenCues TSF' active in this app? ($($_.Exception.Message))"; return }
$sub = [System.Text.Encoding]::UTF8.GetBytes("SUBSCRIBE`n")
$client.Write($sub, 0, $sub.Length); $client.Flush()

$accum = New-Object System.Collections.Generic.List[byte]
$buf = New-Object byte[] 8192
$deadline = [DateTime]::UtcNow.AddSeconds($DurationSec)

function Read-More {
  $ms = [int]([Math]::Max(0, ($script:deadline - [DateTime]::UtcNow).TotalMilliseconds))
  if ($ms -le 0) { return $false }
  $t = $client.ReadAsync($buf, 0, $buf.Length)
  if (-not $t.Wait($ms)) { return $false }
  $n = $t.Result
  if ($n -le 0) { return $false }
  for ($i = 0; $i -lt $n; $i++) { $accum.Add($buf[$i]) }
  return $true
}

Emit "listening ${DurationSec}s - type in the app to generate TEXTCHANGED, switch fields for FOCUS..."
$count = 0
while ([DateTime]::UtcNow -lt $deadline) {
  # header line up to \n (byte 10)
  $nl = $accum.IndexOf([byte]10)
  while ($nl -lt 0) { if (-not (Read-More)) { break }; $nl = $accum.IndexOf([byte]10) }
  if ($nl -lt 0) { break }
  $header = [System.Text.Encoding]::ASCII.GetString($accum.ToArray(), 0, $nl)
  $accum.RemoveRange(0, $nl + 1)
  if ($header.StartsWith("OK")) { Emit "  ($header)"; continue }
  $colon = $header.LastIndexOf(':')
  if ($colon -lt 0) { Emit "  ?? $header"; continue }
  $type = $header.Substring(0, $colon)
  $len = 0; [void][int]::TryParse($header.Substring($colon + 1), [ref]$len)
  while ($accum.Count -lt $len) { if (-not (Read-More)) { break } }
  if ($accum.Count -lt $len) { break }
  $body = [System.Text.Encoding]::UTF8.GetString($accum.ToArray(), 0, $len)
  $accum.RemoveRange(0, $len)
  $count++
  Emit ("  [{0}] {1}" -f $type, ($body -replace "`r", '' -replace "`n", ' | '))
}
$client.Dispose()
Emit "done - $count events in ${DurationSec}s"
