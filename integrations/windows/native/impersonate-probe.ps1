<#
  Standalone probe: does a COMPLETE screen-reader impersonation wake
  Chromium/Electron accessibility so we can read editor text?

  Does all three things a real screen reader does, persistently:
    1. SPI_SETSCREENREADER      - announce screen reader present.
    2. AddAutomationFocusChangedEventHandler - register as a LIVE UIA event
       client (injects provider-side, signals "AT listening"). The step the
       shim never did (it polled instead).
    3. AccessibleObjectFromWindow(renderHwnd, OBJID_CLIENT) via oleacc - the
       PROPER renderer wake (not SendMessage lParam=1).
  Then walks the focused element's subtree for any text-bearing node.

  Run in Windows PowerShell 5.1:
    powershell -ExecutionPolicy Bypass -File <this>
  Then focus VS Code / Discord within the 25s window.
  Results also written to \\wsl.localhost\Ubuntu\tmp\oc-impersonate.log
#>

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OcNative {
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, IntPtr c, uint d);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object acc);
  public const uint OBJID_CLIENT = 0xFFFFFFFC;
  public static void ScreenReaderOn(bool on) { SystemParametersInfo(0x0047, on ? 1u : 0u, IntPtr.Zero, 2); }
  public static int PokeRenderers(IntPtr fg) {
    int n = 0;
    Guid iid = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71"); // IID_IAccessible
    EnumChildWindows(fg, (h, l) => {
      var sb = new StringBuilder(160); GetClassName(h, sb, sb.Capacity);
      if (sb.ToString() == "Chrome_RenderWidgetHostHWND") {
        object acc; Guid i2 = iid;
        try { AccessibleObjectFromWindow(h, OBJID_CLIENT, ref i2, out acc); n++; } catch {}
      }
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@ -ReferencedAssemblies System, System.Core

$logWin = "\\wsl.localhost\Ubuntu\tmp\oc-impersonate.log"
function Say($m) { Write-Host $m; try { $m | Out-File -FilePath $logWin -Append -Encoding utf8 } catch {} }
try { "" | Out-File -FilePath $logWin -Encoding utf8 } catch {}

# 1. Announce screen reader
[OcNative]::ScreenReaderOn($true)

# 2. Register a LIVE focus event handler (the missing 'AT is listening' signal)
$handler = [System.Windows.Automation.AutomationFocusChangedEventHandler]{ param($s, $e) }
try { [System.Windows.Automation.Automation]::AddAutomationFocusChangedEventHandler($handler) } catch { Say "focus-handler register failed: $($_.Exception.Message)" }

Write-Host ""
Write-Host "  >>> CLICK INTO THE DISCORD MESSAGE BOX NOW and STAY THERE. <<<"
Write-Host "  >>> Do NOT come back to this window. Reading starts in 6s.  <<<"
for ($c = 6; $c -gt 0; $c--) { Write-Host "     starting in $c..."; Start-Sleep -Seconds 1 }
Say ("impersonation active (SPI + focus-handler). reading 40s at " + (Get-Date -Format HH:mm:ss))

$AE = [System.Windows.Automation.AutomationElement]
$textAvailProp = [System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty
$valAvailProp  = [System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty

for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 1000
  try {
    $fg = [OcNative]::GetForegroundWindow()
    $poked = [OcNative]::PokeRenderers($fg)    # 3. proper OBJID_CLIENT wake
    Start-Sleep -Milliseconds 150               # let async tree build
    $fe = $AE::FocusedElement
    if ($fe -eq $null) { Say ("[{0}] no focused element" -f $i); continue }
    $app = ""; try { $procId = $fe.Current.ProcessId; $app = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName } catch {}
    $ct = ""; try { $ct = $fe.Current.ControlType.ProgrammaticName } catch {}
    # focused element's own text
    $selfText = ""
    try { $tp = $fe.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern); $selfText = $tp.DocumentRange.GetText(60) } catch {}
    if ($selfText -eq "") { try { $vp = $fe.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $selfText = $vp.Current.Value } catch {} }
    # subtree scan for ANY text-bearing node
    $textNodes = 0; $sample = ""
    try {
      $cond = New-Object System.Windows.Automation.PropertyCondition($textAvailProp, $true)
      $found = $fe.FindAll([System.Windows.Automation.TreeScope]::Subtree, $cond)
      $textNodes = $found.Count
      if ($textNodes -gt 0) {
        for ($k = 0; $k -lt $found.Count -and $sample -eq ""; $k++) {
          try { $tp2 = $found[$k].GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern); $t = $tp2.DocumentRange.GetText(60); if ($t.Trim() -ne "") { $sample = $t } } catch {}
        }
      }
    } catch {}
    $sfl = ($selfText -replace "`r?`n"," ")
    if ($sfl.Length -gt 40) { $sfl = $sfl.Substring(0,40) }
    $spl = ($sample -replace "`r?`n"," ")
    if ($spl.Length -gt 40) { $spl = $spl.Substring(0,40) }
    Say ("[{0}] app={1} ct={2} poked={3} selfText='{4}' subtreeTextNodes={5} sample='{6}'" -f $i, $app, $ct, $poked, $sfl, $textNodes, $spl)
  } catch { Say ("[{0}] read error: {1}" -f $i, $_.Exception.Message) }
}

try { [System.Windows.Automation.Automation]::RemoveAutomationFocusChangedEventHandler($handler) } catch {}
[OcNative]::ScreenReaderOn($false)
Say ("done at " + (Get-Date -Format HH:mm:ss) + " (screen-reader flag reset)")
Write-Host "`nDone. Tell the assistant; results are in the WSL log."
