<#
  MSAA focus-path probe - tests the EXACT algorithm the shim will use.

  Unlike msaa-probe.ps1 (which scanned apps by-process and walked the
  whole renderer tree), this:
    1. Reads the FOREGROUND window only (what the shim's PollFocus sees).
    2. Pokes each Chrome_RenderWidgetHostHWND child with OBJID_CLIENT.
    3. Drills accFocus down to the FOCUSED node (the editable field),
       not a brute-force whole-tree walk.
    4. Reports that node's role / focused / readonly / text.

  It runs TWO phases in one pass so a single test settles the design:
    PHASE A: OBJID_CLIENT poke + a lightweight UIA focus-handler, NO SPI.
    PHASE B: the same, PLUS the global SPI_SETSCREENREADER flag.

  If PHASE A already reads the text, we ship the non-intrusive variant
  (no system-wide screen-reader mode). If only PHASE B reads, SPI is
  load-bearing and we scope it as tightly as possible.

  Run in Windows PowerShell 5.1:
    powershell -ExecutionPolicy Bypass -File <this>
  Then click into the Discord message box, type "hello world", and STAY
  there for ~30s (do not click back to the console).
  Results -> \\wsl.localhost\Ubuntu\tmp\oc-impersonate.log
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using Accessibility;
public static class MsaaFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, IntPtr c, uint d);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, out IAccessible acc);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible c, int start, int count, [Out] object[] children, out int obtained);
  public delegate bool EnumWin(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWin cb, IntPtr l);
  static Guid IID = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
  const uint OBJID_CLIENT = 0xFFFFFFFC;
  const int STATE_FOCUSED = 0x4;
  const int STATE_READONLY = 0x40;
  const int ROLE_STATICTEXT = 0x29;
  const int ROLE_TEXT = 0x2a;

  public static void ScreenReaderOn(bool on) { SystemParametersInfo(0x0047, on ? 1u : 0u, IntPtr.Zero, 2); }

  static System.Collections.Generic.List<IntPtr> WindowsOfProcess(string procName) {
    var pids = new System.Collections.Generic.HashSet<int>();
    foreach (var p in System.Diagnostics.Process.GetProcessesByName(procName)) pids.Add(p.Id);
    var result = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((h, l) => {
      int pid; GetWindowThreadProcessId(h, out pid);
      if (pids.Contains(pid) && IsWindowVisible(h)) result.Add(h);
      return true;
    }, IntPtr.Zero);
    return result;
  }

  static System.Collections.Generic.List<IntPtr> Renderers(IntPtr top) {
    var list = new System.Collections.Generic.List<IntPtr>();
    EnumChildWindows(top, (h, l) => {
      var sb = new StringBuilder(160); GetClassName(h, sb, sb.Capacity);
      if (sb.ToString() == "Chrome_RenderWidgetHostHWND") list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  static bool IsUrl(string s) {
    if (string.IsNullOrEmpty(s)) return true;
    return s.StartsWith("http") || s.StartsWith("vscode-file") || s.StartsWith("data:") || s.StartsWith("blob:") || s.StartsWith("file:");
  }
  static string Trunc(string s, int m) {
    if (s == null) return "";
    s = s.Replace("\r", " ").Replace("\n", " ").Trim();
    return s.Length > m ? s.Substring(0, m) : s;
  }
  static int RoleOf(IAccessible a) { try { var r = a.get_accRole(0); if (r is int) return (int)r; } catch { } return -1; }
  static int StateOf(IAccessible a) { try { var s = a.get_accState(0); if (s is int) return (int)s; } catch { } return 0; }

  // Collect text under a node (accValue everywhere; accName on static text).
  static void CollectText(IAccessible acc, int depth, StringBuilder sb, int[] budget) {
    if (acc == null || depth > 12 || budget[0] <= 0) return;
    budget[0]--;
    string v = null; try { v = acc.get_accValue(0); } catch { }
    if (!IsUrl(v)) { if (sb.Length > 0) sb.Append(" "); sb.Append(v); }
    else {
      int role = RoleOf(acc);
      if (role == ROLE_STATICTEXT) { string nm = null; try { nm = acc.get_accName(0); } catch { } if (!string.IsNullOrEmpty(nm)) { if (sb.Length > 0) sb.Append(" "); sb.Append(nm); } }
    }
    int cc = 0; try { cc = acc.accChildCount; } catch { }
    if (cc <= 0 || cc > 500) return;
    object[] kids = new object[cc]; int got = 0;
    try { AccessibleChildren(acc, 0, cc, kids, out got); } catch { return; }
    for (int i = 0; i < got; i++) { var ia = kids[i] as IAccessible; if (ia != null) CollectText(ia, depth + 1, sb, budget); }
  }

  // Read the FOREGROUND window's focused editable node via MSAA.
  public static string ProbeForeground() {
    IntPtr fg = GetForegroundWindow();
    int pid; GetWindowThreadProcessId(fg, out pid);
    string proc = ""; try { proc = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { }
    var rends = Renderers(fg);
    if (rends.Count == 0) return "proc=" + proc + " (no Chromium renderer child - not Electron/Chromium)";
    int best = -1; string bestText = ""; int bestRole = -1; int bestState = 0; bool isolated = false;
    foreach (var rh in rends) {
      IAccessible root;
      if (AccessibleObjectFromWindow(rh, OBJID_CLIENT, ref IID, out root) != 0 || root == null) continue;
      // Drill accFocus to the deepest focused IAccessible.
      IAccessible cur = root; bool drilled = false;
      for (int i = 0; i < 40; i++) {
        object f = null; try { f = cur.accFocus; } catch { break; }
        if (f == null) break;
        var fa = f as IAccessible;
        if (fa != null && fa != cur) { cur = fa; drilled = true; continue; }
        break;
      }
      int role = RoleOf(cur); int state = StateOf(cur);
      var sb = new StringBuilder(); int[] budget = { 600 };
      CollectText(cur, 0, sb, budget);
      string t = sb.ToString().Trim();
      if (t.Length > best) { best = t.Length; bestText = t; bestRole = role; bestState = state; isolated = drilled; }
    }
    return "proc=" + proc + " renderers=" + rends.Count
      + " isolated=" + isolated
      + " role=0x" + bestRole.ToString("x")
      + " focused=" + ((bestState & STATE_FOCUSED) != 0)
      + " readonly=" + ((bestState & STATE_READONLY) != 0)
      + " text='" + Trunc(bestText, 80) + "'";
  }

  // Read an app BY PROCESS (no focus needed) - brute-walk every renderer
  // tree for text. Proves readability under the current SPI phase even if
  // the user isn't actively focusing the app.
  public static string ProbeProcess(string procName) {
    var wins = WindowsOfProcess(procName);
    if (wins.Count == 0) return procName + ": not running";
    int rcount = 0, best = -1; string sample = "";
    foreach (var w in wins) {
      foreach (var rh in Renderers(w)) {
        rcount++;
        IAccessible root;
        if (AccessibleObjectFromWindow(rh, OBJID_CLIENT, ref IID, out root) != 0 || root == null) continue;
        var sb = new StringBuilder(); int[] budget = { 4000 };
        CollectText(root, 0, sb, budget);
        string t = sb.ToString().Trim();
        if (t.Length > best) { best = t.Length; sample = t; }
      }
    }
    return procName + ": renderers=" + rcount + " textLen=" + best + " sample='" + Trunc(sample, 80) + "'";
  }
}
"@ -ReferencedAssemblies System, System.Core, Accessibility

$logWin = "\\wsl.localhost\Ubuntu\tmp\oc-impersonate.log"
function Say($m) { Write-Host $m; try { $m | Out-File -FilePath $logWin -Append -Encoding utf8 } catch { } }
try { "" | Out-File -FilePath $logWin -Encoding utf8 } catch { }

# Lightweight UIA event client - the non-intrusive "AT is listening" signal
# (does NOT flip other apps into screen-reader mode; SPI does).
$handler = [System.Windows.Automation.AutomationFocusChangedEventHandler]{ param($s, $e) }
try { [System.Windows.Automation.Automation]::AddAutomationFocusChangedEventHandler($handler) } catch { Say ("focus-handler register failed: " + $_.Exception.Message) }

Write-Host ""
Write-Host "  >>> CLICK INTO THE DISCORD MESSAGE BOX, type 'hello world', and STAY. <<<"
Write-Host "  >>> Do NOT click back to this console. Reading starts in 12s.        <<<"
for ($c = 12; $c -gt 0; $c--) { Write-Host "     starting in $c..."; Start-Sleep -Seconds 1 }

Say ("MSAA focus-path probe at " + (Get-Date -Format HH:mm:ss))
Say "PHASE A: OBJID_CLIENT poke + focus-handler, NO SPI"
for ($i = 0; $i -lt 8; $i++) {
  Start-Sleep -Milliseconds 1200
  try { Say ("[A{0}] fg: {1}" -f $i, [MsaaFocus]::ProbeForeground()) } catch { Say ("[A{0}] fg err: {1}" -f $i, $_.Exception.Message) }
  try { Say ("[A{0}] {1}" -f $i, [MsaaFocus]::ProbeProcess('Discord')) } catch { Say ("[A{0}] discord err: {1}" -f $i, $_.Exception.Message) }
}

Say "PHASE B: + SPI_SETSCREENREADER (global screen-reader flag)"
[MsaaFocus]::ScreenReaderOn($true)
for ($i = 0; $i -lt 8; $i++) {
  Start-Sleep -Milliseconds 1200
  try { Say ("[B{0}] fg: {1}" -f $i, [MsaaFocus]::ProbeForeground()) } catch { Say ("[B{0}] fg err: {1}" -f $i, $_.Exception.Message) }
  try { Say ("[B{0}] {1}" -f $i, [MsaaFocus]::ProbeProcess('Discord')) } catch { Say ("[B{0}] discord err: {1}" -f $i, $_.Exception.Message) }
}
[MsaaFocus]::ScreenReaderOn($false)

try { [System.Windows.Automation.Automation]::RemoveAutomationFocusChangedEventHandler($handler) } catch { }
Say ("done at " + (Get-Date -Format HH:mm:ss) + " (SPI reset)")
Write-Host "`nDone. Results are in the WSL log."
