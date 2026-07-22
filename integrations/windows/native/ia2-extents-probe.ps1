<#
  IA2 characterExtents probe - READ-ONLY.

  VERDICT (2026-07-22, Chrome stable on Win11): DEAD END - do not re-run
  expecting a different answer without a changed premise. Three escalating
  runs against the omnibox:
    1. default            -> QueryService(IAccessible2) = E_NOINTERFACE
    2. SPI_SETSCREENREADER on, live  -> same
    3. SPI_SETSCREENREADER on + full chrome://restart -> same
  The omnibox node IS reachable over MSAA (role TEXT, IServiceProvider
  answers) but Chromium refuses the IA2 family to this client in every
  mode we can reach out-of-process. Renderer-side documents refuse too
  (E_NOINTERFACE / E_INVALIDARG). Conclusion: no per-character pixel
  geometry exists for out-of-process clients on Chromium stub fields -
  UIA (managed + native) returns the frozen 2px stub, IA2 is withheld.
  Consequence: stub-geometry fields get the WHOLE-FIELD indication
  embodiment instead of synthesized per-word marks.

  Question: does Chromium serve real per-character pixel geometry via
  IAccessibleText::get_characterExtents where UIA's GetBoundingRectangles
  returns the frozen 2px stub (the omnibox, Slack, Discord)?

  Unlike ia2-write-probe.ps1 this one:
    * never writes (no insertText/replaceText) - safe on any field;
    * also drills the TOP-LEVEL Chrome HWND, not just the
      Chrome_RenderWidgetHostHWND renderers - the omnibox is a Views
      control that lives outside the renderer tree;
    * loops for ~45s so you can click into the omnibox after launch.

  Run in Windows PowerShell 5.1:
    powershell -ExecutionPolicy Bypass -File <this>
  Then click into the CHROME OMNIBOX (with some text in it) and stay.
  Results -> \\wsl.localhost\Ubuntu\tmp\oc-ia2-extents.log
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using Accessibility;

[ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IServiceProvider {
  [PreserveSig] int QueryService(ref Guid guidService, ref Guid riid, out IntPtr ppvObject);
}

[ComImport, Guid("4E747BE5-2052-4265-8BF7-EB40A26E2A96"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAccessibleText {
  [PreserveSig] int addSelection(int startOffset, int endOffset);
  [PreserveSig] int get_attributes(int offset, out int startOffset, out int endOffset, [MarshalAs(UnmanagedType.BStr)] out string textAttributes);
  [PreserveSig] int get_caretOffset(out int offset);
  [PreserveSig] int get_characterExtents(int offset, int coordType, out int x, out int y, out int width, out int height);
  [PreserveSig] int get_nSelections(out int nSelections);
  [PreserveSig] int get_offsetAtPoint(int x, int y, int coordType, out int offset);
  [PreserveSig] int get_selection(int selectionIndex, out int startOffset, out int endOffset);
  [PreserveSig] int get_text(int startOffset, int endOffset, [MarshalAs(UnmanagedType.BStr)] out string text);
  [PreserveSig] int get_textBeforeOffset(int offset, int boundaryType, out int startOffset, out int endOffset, [MarshalAs(UnmanagedType.BStr)] out string text);
  [PreserveSig] int get_textAfterOffset(int offset, int boundaryType, out int startOffset, out int endOffset, [MarshalAs(UnmanagedType.BStr)] out string text);
  [PreserveSig] int get_textAtOffset(int offset, int boundaryType, out int startOffset, out int endOffset, [MarshalAs(UnmanagedType.BStr)] out string text);
  [PreserveSig] int removeSelection(int selectionIndex);
  [PreserveSig] int setCaretOffset(int offset);
  [PreserveSig] int setSelection(int selectionIndex, int startOffset, int endOffset);
  [PreserveSig] int get_nCharacters(out int nCharacters);
  [PreserveSig] int scrollSubstringTo(int startIndex, int endIndex, int scrollType);
  [PreserveSig] int scrollSubstringToPoint(int startIndex, int endIndex, int coordType, int x, int y);
}

public static class Ia2ExtentsProbe {
  // Screen-reader flag: Chromium serves IA2 only to clients it believes
  // are screen readers; QueryService(IAccessible2) alone returned
  // E_NOINTERFACE on every node (probe run 2026-07-22). NVDA's signal is
  // this flag - set it for the probe window, restore after.
  [DllImport("user32.dll", SetLastError=true)] static extern bool SystemParametersInfo(uint action, uint p, ref bool v, uint winIni);
  const uint SPI_GETSCREENREADER = 0x0046, SPI_SETSCREENREADER = 0x0047;
  const uint SPIF_SENDCHANGE = 0x2;
  public static bool GetScreenReader() { bool v = false; SystemParametersInfo(SPI_GETSCREENREADER, 0, ref v, 0); return v; }
  public static void SetScreenReader(bool on) { bool v = on; SystemParametersInfo(SPI_SETSCREENREADER, (uint)(on ? 1 : 0), ref v, SPIF_SENDCHANGE); }

  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, out IAccessible acc);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible c, int start, int count, [Out] object[] children, out int obtained);
  [StructLayout(LayoutKind.Sequential)]
  struct GUITHREADINFO { public uint cbSize, flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public int l, t, r, b; }
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO gui);

  static Guid IID_IAccessible = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
  static Guid IID_IA2 = new Guid("E89F726E-C4F4-4c19-BB19-B647D7FA8478");
  static Guid IID_IAText = new Guid("4E747BE5-2052-4265-8BF7-EB40A26E2A96");
  const uint OBJID_CLIENT = 0xFFFFFFFC;

  static int RoleOf(IAccessible a) { try { var r = a.get_accRole(0); if (r is int) return (int)r; } catch { } return -1; }
  static string NameOf(IAccessible a) { try { return a.get_accName(0); } catch { return null; } }
  static string Trunc(string s, int m) {
    if (s == null) return "<null>";
    s = s.Replace("\r"," ").Replace("\n"," ");
    return s.Length > m ? s.Substring(0, m) + "..." : s;
  }

  static IAccessibleText QIText(object node, out string how) {
    how = "";
    try { var x = node as IAccessibleText; if (x != null) { how = "direct-QI"; return x; } } catch {}
    var sp = node as IServiceProvider;
    if (sp == null) { how = "no-IServiceProvider"; return null; }
    try {
      IntPtr p; int hr = sp.QueryService(ref IID_IA2, ref IID_IAText, out p);
      if (hr == 0 && p != IntPtr.Zero) {
        object o = Marshal.GetObjectForIUnknown(p); Marshal.Release(p);
        var x = o as IAccessibleText; if (x != null) { how = "QueryService"; return x; }
      }
      how = "QS hr=0x" + hr.ToString("x8");
    } catch (Exception ex) { how = "ex:" + ex.Message; }
    return null;
  }

  static void FindTextNodes(IAccessible acc, int depth, System.Collections.Generic.List<IAccessible> hits, int[] budget) {
    if (acc == null || depth > 14 || budget[0] <= 0 || hits.Count >= 8) return;
    budget[0]--;
    string how; var t = QIText(acc, out how);
    if (t != null) hits.Add(acc);
    int cc = 0; try { cc = acc.accChildCount; } catch { }
    if (cc <= 0 || cc > 400) return;
    object[] kids = new object[cc]; int got = 0;
    try { AccessibleChildren(acc, 0, cc, kids, out got); } catch { return; }
    for (int i = 0; i < got; i++) { var ia = kids[i] as IAccessible; if (ia != null) FindTextNodes(ia, depth + 1, hits, budget); }
  }

  static IAccessible DrillFocus(IAccessible root) {
    IAccessible cur = root;
    for (int i = 0; i < 40; i++) {
      object f = null; try { f = cur.accFocus; } catch { break; }
      var fa = f as IAccessible;
      if (fa != null && fa != cur) { cur = fa; continue; }
      break;
    }
    return cur;
  }

  static void DumpExtents(StringBuilder sb, IAccessibleText t, string label) {
    int n = -1, caret = -1, hr;
    hr = t.get_nCharacters(out n);
    if (hr != 0 || n <= 0) { sb.AppendLine("  [" + label + "] nChars hr=0x" + hr.ToString("x8") + " n=" + n + " - skip"); return; }
    t.get_caretOffset(out caret);
    string txt = null; t.get_text(0, n, out txt);
    sb.AppendLine("  [" + label + "] n=" + n + " caret=" + caret + " text='" + Trunc(txt, 60) + "'");
    // Extents for the first chars + every ~word boundary; coordType 0 = SCREEN.
    int shown = 0;
    for (int i = 0; i < n && shown < 14; i++) {
      bool interesting = i < 6 || i == n - 1 || (txt != null && i > 0 && i < txt.Length && txt[i - 1] == ' ');
      if (!interesting) continue;
      int x, y, w, h2;
      hr = t.get_characterExtents(i, 0, out x, out y, out w, out h2);
      char c2 = (txt != null && i < txt.Length) ? txt[i] : '?';
      sb.AppendLine("    ext[" + i + " '" + c2 + "'] hr=0x" + hr.ToString("x8") + " -> " + x + "," + y + " " + w + "x" + h2);
      shown++;
    }
    // offsetAtPoint round-trip on char 2 if it had a rect
    if (n > 2) {
      int x, y, w, h2;
      if (t.get_characterExtents(2, 0, out x, out y, out w, out h2) == 0 && w > 0) {
        int off; hr = t.get_offsetAtPoint(x + w / 2, y + h2 / 2, 0, out off);
        sb.AppendLine("    offsetAtPoint(mid of ext[2]) hr=0x" + hr.ToString("x8") + " -> " + off + (off == 2 ? "  OK ROUND-TRIP" : ""));
      }
    }
  }

  public static string Run() {
    var sb = new StringBuilder();
    IntPtr fg = GetForegroundWindow();
    int pid; uint tid = GetWindowThreadProcessId(fg, out pid);
    string proc = ""; try { proc = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { }
    sb.AppendLine("pass: proc=" + proc);
    if (proc.IndexOf("chrome", StringComparison.OrdinalIgnoreCase) < 0
        && proc.IndexOf("msedge", StringComparison.OrdinalIgnoreCase) < 0) {
      sb.AppendLine("  (foreground is not chrome - focus the omnibox)"); return sb.ToString();
    }

    // Route A: the focused HWND itself (Views controls incl. the omnibox
    // live under the top-level Chrome_WidgetWin HWND, not a renderer).
    var g = new GUITHREADINFO(); g.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
    IntPtr focusHwnd = GetGUIThreadInfo(tid, ref g) && g.hwndFocus != IntPtr.Zero ? g.hwndFocus : fg;
    var sbc = new StringBuilder(160); GetClassName(focusHwnd, sbc, sbc.Capacity);
    sb.AppendLine("  focus hwnd class=" + sbc);

    var roots = new System.Collections.Generic.List<System.Collections.Generic.KeyValuePair<string, IntPtr>>();
    roots.Add(new System.Collections.Generic.KeyValuePair<string, IntPtr>("focus-hwnd", focusHwnd));
    if (focusHwnd != fg) roots.Add(new System.Collections.Generic.KeyValuePair<string, IntPtr>("top-level", fg));
    EnumChildWindows(fg, (h, l) => {
      var s2 = new StringBuilder(160); GetClassName(h, s2, s2.Capacity);
      if (s2.ToString() == "Chrome_RenderWidgetHostHWND") roots.Add(new System.Collections.Generic.KeyValuePair<string, IntPtr>("renderer", h));
      return true;
    }, IntPtr.Zero);

    bool any = false;
    foreach (var kv in roots) {
      IAccessible root;
      if (AccessibleObjectFromWindow(kv.Value, OBJID_CLIENT, ref IID_IAccessible, out root) != 0 || root == null) {
        sb.AppendLine("  [" + kv.Key + "] AccessibleObjectFromWindow failed"); continue;
      }
      var focused = DrillFocus(root);
      string how; var direct = QIText(focused, out how);
      if (direct != null) {
        sb.AppendLine("  [" + kv.Key + "] focused node role=0x" + RoleOf(focused).ToString("x")
          + " name='" + Trunc(NameOf(focused), 28) + "' HAS IAccessibleText (" + how + ")");
        DumpExtents(sb, direct, kv.Key + "/focused"); any = true;
      } else {
        var hits = new System.Collections.Generic.List<IAccessible>(); int[] budget = { 500 };
        FindTextNodes(focused, 0, hits, budget);
        sb.AppendLine("  [" + kv.Key + "] focused node role=0x" + RoleOf(focused).ToString("x")
          + " no direct text iface (" + how + "); subtree hits=" + hits.Count);
        foreach (var hnode in hits) {
          string how2; var t2 = QIText(hnode, out how2);
          if (t2 != null) { DumpExtents(sb, t2, kv.Key + "/subtree"); any = true; break; }
        }
      }
    }
    if (!any) sb.AppendLine("  -> NO IAccessibleText reachable this pass");
    return sb.ToString();
  }
}
"@ -ReferencedAssemblies System, System.Core, Accessibility

$logWin = "\\wsl.localhost\Ubuntu\tmp\oc-ia2-extents.log"
function Say($m) { Write-Host $m; try { $m | Out-File -FilePath $logWin -Append -Encoding utf8 } catch { } }
try { "" | Out-File -FilePath $logWin -Encoding utf8 } catch { }

# Register as a UIA client so Chromium wakes its a11y tree (same
# non-intrusive wake the shim uses; no global SPI_SETSCREENREADER).
$handler = [System.Windows.Automation.AutomationFocusChangedEventHandler]{ param($s, $e) }
try { [System.Windows.Automation.Automation]::AddAutomationFocusChangedEventHandler($handler) } catch { Say ("focus-handler register failed: " + $_.Exception.Message) }

Say ("IA2 extents probe (read-only, screen-reader-flag variant) at " + (Get-Date -Format HH:mm:ss))
Say ">>> Click into the CHROME OMNIBOX (with text in it) and stay there. Waits up to 5 min for chrome, then 10 chrome passes. <<<"
$hadSR = [Ia2ExtentsProbe]::GetScreenReader()
Say ("screen-reader flag before: " + $hadSR)
if (-not $hadSR) { [Ia2ExtentsProbe]::SetScreenReader($true); Say "screen-reader flag SET (will restore at exit)" }
try {
  $chromePasses = 0; $i = 0
  while ($chromePasses -lt 10 -and $i -lt 100) {
    Start-Sleep -Seconds 3
    $i++
    try {
      $out = [Ia2ExtentsProbe]::Run()
      if ($out -match 'not chrome') {
        if ($i % 10 -eq 0) { Say ("(still waiting for chrome to be foreground - attempt $i)") }
      } else {
        $chromePasses++
        Say ("--- chrome pass $chromePasses --- " + (Get-Date -Format HH:mm:ss))
        Say $out
      }
    } catch { Say ("pass threw: " + $_.Exception.Message) }
  }
} finally {
  if (-not $hadSR) { [Ia2ExtentsProbe]::SetScreenReader($false); Say "screen-reader flag restored to off" }
}
Say "probe done."
