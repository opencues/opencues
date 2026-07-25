<#
  Native-UIA probe. Answers the question the earlier probes could NOT:
  does Chromium/Electron (Discord, Slack) serve a text/caret surface to a
  MODERN native UIA client?

  Why the earlier answer may be wrong:
    * slack-uia-probe.ps1 used the LEGACY managed API
      (System.Windows.Automation, .NET 3.0-era). Chromium implements
      MODERN native UIA (the IUIAutomation COM API - what Narrator and
      Edge use); the managed wrapper is known to miss provider surfaces
      the native API serves. "TextPattern=False" from managed UIA may
      just mean "wrong API generation".
    * ia2-write-probe.ps1 ran WITHOUT SPI_SETSCREENREADER. Chromium
      builds a fuller accessibility tree when it detects a real screen
      reader; the text interfaces may only exist in that mode.

  What this probe does: creates a native IUIAutomation client (CUIAutomation8
  via COM), then samples the FOCUSED element every 3s for ~60s, reporting:
    proc / ControlType / ClassName / FrameworkId / Name
    IsValuePatternAvailable / IsTextPatternAvailable /
    IsTextPattern2Available / IsTextEditPatternAvailable / Value.Value

  FrameworkId is the tell: native Chromium-UIA reports "Chrome"; the
  MSAA/IA2 bridge reports "MSAA"/"Win32". If Text*=True with fw=Chrome,
  there IS a native text/caret surface and a follow-up probe can drive it.

  PHASE A (first ~30s): plain native client, no SPI.
  PHASE B (second ~30s): + SPI_SETSCREENREADER (reset at the end).

  Run in Windows PowerShell 5.1:
    powershell -ExecutionPolicy Bypass -File <this>
  Then click into the DISCORD message box and stay ~15s, then switch to
  the SLACK message box and stay. Repeat in phase B if you can.
  Results -> \\wsl.localhost\Ubuntu\tmp\oc-uia-native-probe.log
#>
$ErrorActionPreference = 'Continue'

Add-Type @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct tagPOINT { public int x; public int y; }

// Partial IUIAutomation - vtable order per UIAutomationClient.idl; we only
// call GetFocusedElement (slot 6 after IUnknown) so later methods are omitted.
[ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomation {
  [PreserveSig] int CompareElements(IntPtr el1, IntPtr el2, out int areSame);
  [PreserveSig] int CompareRuntimeIds(IntPtr r1, IntPtr r2, out int areSame);
  [PreserveSig] int GetRootElement(out IUIAutomationElement root);
  [PreserveSig] int ElementFromHandle(IntPtr hwnd, out IUIAutomationElement element);
  [PreserveSig] int ElementFromPoint(tagPOINT pt, out IUIAutomationElement element);
  [PreserveSig] int GetFocusedElement(out IUIAutomationElement element);
}

// Partial IUIAutomationElement - we only call GetCurrentPropertyValue (slot 8).
[ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationElement {
  [PreserveSig] int SetFocus();
  [PreserveSig] int GetRuntimeId(out IntPtr runtimeId);
  [PreserveSig] int FindFirst(int scope, IntPtr condition, out IUIAutomationElement found);
  [PreserveSig] int FindAll(int scope, IntPtr condition, out IntPtr found);
  [PreserveSig] int FindFirstBuildCache(int scope, IntPtr condition, IntPtr cacheRequest, out IUIAutomationElement found);
  [PreserveSig] int FindAllBuildCache(int scope, IntPtr condition, IntPtr cacheRequest, out IntPtr found);
  [PreserveSig] int BuildUpdatedCache(IntPtr cacheRequest, out IUIAutomationElement updated);
  [PreserveSig] int GetCurrentPropertyValue(int propertyId, [MarshalAs(UnmanagedType.Struct)] out object retVal);
}

public static class UiaNative {
  static Guid CLSID_CUIAutomation8 = new Guid("E22AD333-B25F-460C-83D0-0581107395C9");
  static Guid CLSID_CUIAutomation  = new Guid("FF48DBA4-60EF-4201-AA87-54103EEF594E");
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint a, uint b, IntPtr c, uint d);
  public static void ScreenReader(bool on) { SystemParametersInfo(0x0047, on ? 1u : 0u, IntPtr.Zero, 2); }

  static IUIAutomation _uia;
  static IUIAutomation Uia() {
    if (_uia != null) return _uia;
    object o = null;
    try {
      Type t8 = Type.GetTypeFromCLSID(CLSID_CUIAutomation8, false);
      if (t8 != null) o = Activator.CreateInstance(t8);
    } catch { }
    if (o == null) {
      Type t = Type.GetTypeFromCLSID(CLSID_CUIAutomation, true);
      o = Activator.CreateInstance(t);
    }
    _uia = (IUIAutomation)o;
    return _uia;
  }

  static string PropS(IUIAutomationElement el, int id) {
    object v;
    try { if (el.GetCurrentPropertyValue(id, out v) == 0 && v != null) return v.ToString(); } catch { }
    return "";
  }
  static bool PropB(IUIAutomationElement el, int id) {
    object v;
    try { if (el.GetCurrentPropertyValue(id, out v) == 0 && v is bool) return (bool)v; } catch { }
    return false;
  }
  static string Trunc(string s, int m) {
    if (s == null) return "";
    s = s.Replace("\r", " ").Replace("\n", " ");
    return s.Length > m ? s.Substring(0, m) : s;
  }

  // UIA property ids: 30002 ProcessId, 30003 ControlType, 30005 Name,
  // 30012 ClassName, 30024 FrameworkId, 30040 IsTextPatternAvailable,
  // 30043 IsValuePatternAvailable, 30045 Value.Value,
  // 30119 IsTextPattern2Available, 30149 IsTextEditPatternAvailable.
  public static string Sample() {
    IUIAutomationElement el;
    int hr = Uia().GetFocusedElement(out el);
    if (hr != 0 || el == null) return "GetFocusedElement hr=0x" + hr.ToString("x8");
    string procName = "";
    try {
      int pid = 0; int.TryParse(PropS(el, 30002), out pid);
      if (pid > 0) procName = System.Diagnostics.Process.GetProcessById(pid).ProcessName;
    } catch { }
    string ct   = PropS(el, 30003);
    string cls  = PropS(el, 30012);
    string fw   = PropS(el, 30024);
    string name = Trunc(PropS(el, 30005), 24);
    bool v   = PropB(el, 30043);
    bool tx  = PropB(el, 30040);
    bool tx2 = PropB(el, 30119);
    bool te  = PropB(el, 30149);
    string val = Trunc(PropS(el, 30045), 24);
    return "proc=" + procName + " ct=" + ct + " class='" + cls + "' fw='" + fw + "' name='" + name
      + "' | Value=" + v + " Text=" + tx + " Text2=" + tx2 + " TextEdit=" + te + " val='" + val + "'";
  }
}
"@ -ReferencedAssemblies System, System.Core

$logWin = "\\wsl.localhost\Ubuntu\tmp\oc-uia-native-probe.log"
function Say($m) {
  Write-Host $m
  try { $m | Out-File -FilePath $logWin -Append -Encoding utf8 } catch { }
}
try { "" | Out-File -FilePath $logWin -Encoding utf8 } catch { }

Write-Host ""
Write-Host "  >>> Click into the DISCORD message box (type something) and stay ~15s, <<<"
Write-Host "  >>> then switch to the SLACK message box and stay. 60s total.          <<<"
for ($c = 8; $c -gt 0; $c--) {
  Write-Host "     starting in $c..."
  Start-Sleep -Seconds 1
}

Say ("native-UIA probe at " + (Get-Date -Format HH:mm:ss))
$last = ""

Say "PHASE A: native IUIAutomation client, no SPI"
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Milliseconds 3000
  $s = ""
  try { $s = [UiaNative]::Sample() } catch { $s = ("sample threw: " + $_.Exception.Message) }
  if ($s -ne $last) { Say ("[A$i] $s"); $last = $s }
}

Say "PHASE B: + SPI_SETSCREENREADER (screen-reader mode on)"
[UiaNative]::ScreenReader($true)
$last = ""
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Milliseconds 3000
  $s = ""
  try { $s = [UiaNative]::Sample() } catch { $s = ("sample threw: " + $_.Exception.Message) }
  if ($s -ne $last) { Say ("[B$i] $s"); $last = $s }
}
[UiaNative]::ScreenReader($false)

Say ("done at " + (Get-Date -Format HH:mm:ss) + " (SPI reset)")
Write-Host ""
Write-Host "Done. Results -> /tmp/oc-uia-native-probe.log"
