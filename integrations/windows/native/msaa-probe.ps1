<#
  MSAA/IA2 read probe, v2 - targets apps BY PROCESS (no focus needed).
  Finds Discord's / VS Code's windows itself, pokes each Chromium renderer
  with OBJID_CLIENT, and walks the returned IAccessible tree for text
  (accValue) - the MSAA/IA2 path Electron actually uses.

  Just have Discord + VS Code open with some text typed in their inputs.
  Run: powershell -ExecutionPolicy Bypass -File <this>
  Results -> \\wsl.localhost\Ubuntu\tmp\oc-impersonate.log
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Accessibility;
public static class Msaa {
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, IntPtr c, uint d);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, out IAccessible acc);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible c, int start, int count, [Out] object[] children, out int obtained);
  static Guid IID = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
  const uint OBJID_CLIENT = 0xFFFFFFFC;

  public static void ScreenReaderOn(bool on) { SystemParametersInfo(0x0047, on ? 1u : 0u, IntPtr.Zero, 2); }

  static List<IntPtr> WindowsOfProcess(string procName) {
    var pids = new HashSet<int>();
    foreach (var p in System.Diagnostics.Process.GetProcessesByName(procName)) pids.Add(p.Id);
    var result = new List<IntPtr>();
    EnumWindows((h, l) => {
      int pid; GetWindowThreadProcessId(h, out pid);
      if (pids.Contains(pid) && IsWindowVisible(h)) result.Add(h);
      return true;
    }, IntPtr.Zero);
    return result;
  }

  static List<IntPtr> Renderers(IntPtr top) {
    var list = new List<IntPtr>();
    EnumChildWindows(top, (h, l) => {
      var sb = new StringBuilder(160); GetClassName(h, sb, sb.Capacity);
      if (sb.ToString() == "Chrome_RenderWidgetHostHWND") list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  // For a process: find its windows, poke every renderer, MSAA-walk, report.
  public static string Probe(string procName) {
    var wins = WindowsOfProcess(procName);
    if (wins.Count == 0) return procName + ": not running / no windows";
    int rcount = 0, best = 0; string sample = "";
    foreach (var w in wins) {
      foreach (var rh in Renderers(w)) {
        rcount++;
        IAccessible root;
        if (AccessibleObjectFromWindow(rh, OBJID_CLIENT, ref IID, out root) != 0 || root == null) continue;
        int[] n = { 0 }; int[] texts = { 0 }; var s = new StringBuilder();
        Walk(root, 0, n, texts, s);
        if (texts[0] > best) { best = texts[0]; sample = s.ToString(); }
      }
    }
    return procName + ": windows=" + wins.Count + " renderers=" + rcount + " textNodes=" + best + " sample='" + Trunc(sample, 90) + "'";
  }

  static bool IsUrl(string s) {
    return s.StartsWith("http") || s.StartsWith("vscode-file") || s.StartsWith("data:") || s.StartsWith("blob:") || s.StartsWith("file:");
  }

  static string Trunc(string s, int max) {
    if (s == null) return "";
    s = s.Replace("\r", " ").Replace("\n", " ").Trim();
    return s.Length > max ? s.Substring(0, max) : s;
  }

  static void Walk(IAccessible acc, int depth, int[] n, int[] texts, StringBuilder sample) {
    if (acc == null || n[0] >= 6000 || depth > 30) return;
    n[0]++;
    string val = null;
    try { val = acc.get_accValue(0); } catch { }
    if (!string.IsNullOrEmpty(val) && !IsUrl(val)) { texts[0]++; if (sample.Length < 120) { if (sample.Length > 0) sample.Append(" | "); sample.Append(val); } }
    int cc = 0; try { cc = acc.accChildCount; } catch { }
    if (cc <= 0) return;
    object[] kids = new object[cc]; int got = 0;
    try { AccessibleChildren(acc, 0, cc, kids, out got); } catch { return; }
    for (int i = 0; i < got; i++) {
      var ia = kids[i] as IAccessible;
      if (ia != null) Walk(ia, depth + 1, n, texts, sample);
      else if (kids[i] is int) { try { var cv = acc.get_accValue(kids[i]); if (!string.IsNullOrEmpty(cv) && !IsUrl(cv)) { texts[0]++; if (sample.Length < 120) { if (sample.Length > 0) sample.Append(" | "); sample.Append(cv); } } } catch { } }
    }
  }
}
"@ -ReferencedAssemblies System, System.Core, Accessibility

$logWin = "\\wsl.localhost\Ubuntu\tmp\oc-impersonate.log"
function Say($m) { Write-Host $m; try { $m | Out-File -FilePath $logWin -Append -Encoding utf8 } catch {} }
try { "" | Out-File -FilePath $logWin -Encoding utf8 } catch {}

[Msaa]::ScreenReaderOn($true)
$handler = [System.Windows.Automation.AutomationFocusChangedEventHandler]{ param($s, $e) }
try { [System.Windows.Automation.Automation]::AddAutomationFocusChangedEventHandler($handler) } catch {}

Say ("MSAA by-process probe at " + (Get-Date -Format HH:mm:ss) + " - no focus needed, just have Discord/VSCode open")
$apps = @('Discord', 'Code', 'Slack', 'obsidian')
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Milliseconds 1500
  foreach ($a in $apps) {
    try { Say ("[{0}] {1}" -f $i, [Msaa]::Probe($a)) } catch { Say ("[{0}] {1} err: {2}" -f $i, $a, $_.Exception.Message) }
  }
}

try { [System.Windows.Automation.Automation]::RemoveAutomationFocusChangedEventHandler($handler) } catch {}
[Msaa]::ScreenReaderOn($false)
Say ("done at " + (Get-Date -Format HH:mm:ss))
Write-Host "`nDone."
