<#
  Slack UIA TextPattern probe. Slack attaches via UIA (writable ValuePattern),
  not MSAA like Discord, so it may expose the UIA TextPattern / TextPattern2
  surface: text ranges, GetSelection, GetCaretRange, and range.Select().

  We cannot get a positioned WRITE this way (text still goes through
  ValuePattern.SetValue), but if range.Select() on a COLLAPSED end-range moves
  the caret cleanly, that is the fix for Slack's caret-jump-to-front after
  SetValue: a proper caret model instead of a synthetic Ctrl+End.

  Reports, for the focused element: which patterns it supports; the current
  text, selection and caret offset; and the CARET-MOVE TEST (collapse a range
  to the document END, Select() it, re-read the caret - did it land at the end
  with no visible highlight?).

  Run in Windows PowerShell 5.1:
    powershell -ExecutionPolicy Bypass -File <this>
  Then click into the SLACK message box, type "hello world", and STAY there.
  Results -> \\wsl.localhost\Ubuntu\tmp\oc-slack-uia-probe.log
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$A   = [System.Windows.Automation.AutomationElement]
$VP  = [System.Windows.Automation.ValuePattern]
$TP  = [System.Windows.Automation.TextPattern]
$EP_Start = [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start
$EP_End   = [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End

$logWin = "\\wsl.localhost\Ubuntu\tmp\oc-slack-uia-probe.log"
function Say($m) {
  Write-Host $m
  try { $m | Out-File -FilePath $logWin -Append -Encoding utf8 } catch { }
}
try { "" | Out-File -FilePath $logWin -Encoding utf8 } catch { }

function Trunc($s, $m) {
  if ($null -eq $s) { return '<null>' }
  $s = ($s -replace "`r", ' ') -replace "`n", ' '
  if ($s.Length -gt $m) { return $s.Substring(0, $m) + '...' }
  return $s
}

# Char offset of a range's START from the document start.
function OffsetOf($tp, $range) {
  try {
    $r = $tp.DocumentRange.Clone()
    $null = $r.MoveEndpointByRange($EP_End, $range, $EP_Start)
    return $r.GetText(-1).Length
  } catch {
    return -1
  }
}

# Wake Chromium/Electron a11y (non-intrusive UIA event-client signal; no SPI).
$handler = [System.Windows.Automation.AutomationFocusChangedEventHandler]{ param($s, $e) }
try { [System.Windows.Automation.Automation]::AddAutomationFocusChangedEventHandler($handler) } catch { Say ("focus-handler: " + $_.Exception.Message) }

Write-Host ""
Write-Host "  >>> Click into the SLACK message box, type 'hello world', and STAY. <<<"
for ($c = 12; $c -gt 0; $c--) {
  Write-Host "     starting in $c..."
  Start-Sleep -Seconds 1
}

Say ("Slack UIA probe at " + (Get-Date -Format HH:mm:ss))

$el = $null
try { $el = $A::FocusedElement } catch { Say ("FocusedElement threw: " + $_.Exception.Message) }

if ($null -eq $el) {
  Say "no focused element"
} else {
  $proc = ""
  try { $proc = (Get-Process -Id $el.Current.ProcessId).ProcessName } catch { }
  Say ("focused: proc=$proc ct=" + $el.Current.ControlType.ProgrammaticName + " class='" + $el.Current.ClassName + "' name='" + (Trunc $el.Current.Name 30) + "'")

  $hasValue = $false
  $tp = $null
  $tp2 = $null
  $hasText2 = $false
  try { $null = $el.GetCurrentPattern($VP::Pattern); $hasValue = $true } catch { }
  try { $tp = $el.GetCurrentPattern($TP::Pattern) } catch { }
  try {
    $tp2 = $el.GetCurrentPattern([System.Windows.Automation.TextPattern2]::Pattern)
    $hasText2 = ($null -ne $tp2)
  } catch { }
  Say ("patterns: ValuePattern=$hasValue TextPattern=" + ($null -ne $tp) + " TextPattern2=$hasText2")

  if ($hasValue) {
    $vp = $el.GetCurrentPattern($VP::Pattern)
    Say ("  ValuePattern: readonly=" + $vp.Current.IsReadOnly + " value='" + (Trunc $vp.Current.Value 50) + "'")
  }

  if ($null -eq $tp) {
    Say "  no TextPattern - Slack does NOT expose the UIA text surface here; caret control via this path is unavailable."
  } else {
    $docLen = 0
    try { $docLen = $tp.DocumentRange.GetText(-1).Length } catch { }
    Say ("  TextPattern text='" + (Trunc $tp.DocumentRange.GetText(200) 60) + "' docLen=$docLen")

    $sel = $null
    try { $sel = $tp.GetSelection() } catch { Say ("  GetSelection threw: " + $_.Exception.Message) }
    if ($sel -and $sel.Length -gt 0) {
      Say ("  selection: count=" + $sel.Length + " start-offset=" + (OffsetOf $tp $sel[0]))
    } else {
      Say "  selection: none reported"
    }

    if ($hasText2) {
      $isActive = $false
      try {
        $caret = $tp2.GetCaretRange([ref]$isActive)
        Say ("  GetCaretRange: active=$isActive caretOffset=" + (OffsetOf $tp $caret))
      } catch {
        Say ("  GetCaretRange threw: " + $_.Exception.Message)
      }
    }

    # CARET-MOVE TEST: collapse a range to the document END and Select() it.
    try {
      $endr = $tp.DocumentRange.Clone()
      $null = $endr.MoveEndpointByRange($EP_Start, $tp.DocumentRange, $EP_End)
      $endr.Select()
      Start-Sleep -Milliseconds 150
      $after = -1
      if ($hasText2) {
        $isA = $false
        $c2 = $tp2.GetCaretRange([ref]$isA)
        $after = OffsetOf $tp $c2
      } else {
        $s2 = $tp.GetSelection()
        if ($s2 -and $s2.Length -gt 0) { $after = OffsetOf $tp $s2[0] }
      }
      $verdict = "caret at $after, expected $docLen -> NO MOVE"
      if ($after -eq $docLen -and $docLen -ge 0) { $verdict = "caret at $after == docLen -> MOVED to END (collapsed range, no highlight)" }
      Say ("  Select(end-collapsed): $verdict")
    } catch {
      Say ("  caret-move test threw: " + $_.Exception.Message)
    }
  }
}

try { [System.Windows.Automation.Automation]::RemoveAutomationFocusChangedEventHandler($handler) } catch { }
Say ("done at " + (Get-Date -Format HH:mm:ss))
Write-Host ""
Write-Host "Done. Results -> /tmp/oc-slack-uia-probe.log"
