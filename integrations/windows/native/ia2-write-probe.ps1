<#
  IA2 write/caret probe — can we drive Chromium/Electron editors (Discord,
  Slack) via IAccessible2 the way we drive RichEdit via EM_* messages?

  RichEdit's win (EM_REPLACESEL / EM_HIDESELECTION) is Win32-Edit-control-
  specific. Chromium renders its own text, so there are no EM_* messages.
  The Chromium-world analog is IAccessible2 — and unlike EM_GETOLEINTERFACE
  (in-process-only pointer, unreachable from our out-of-process shim), IA2
  interfaces MARSHAL across processes. So they're reachable. The open
  question is what Chromium actually IMPLEMENTS:

    • IAccessibleText  (get/setCaretOffset, get/setSelection, get_text)
        — expected to work (screen readers rely on it). Would give exact
          caret + text reads and caret positioning → convergent micro-frames
          + a clean fix for Slack's caret-jump.
    • IAccessibleEditableText (insertText / replaceText / deleteText …)
        — UNKNOWN. Blink implements IA2 for READING; the write side may be
          E_NOTIMPL. If it works, it's the real EM_REPLACESEL analog:
          positioned writes, no clipboard, no select-all flash, no drift.

  This probe drills to the focused editable node (same algorithm the shim
  uses), obtains IAccessibleText + IAccessibleEditableText (both by direct
  QI and via IServiceProvider→IA2), and exercises each — reporting the
  HRESULT and, for writes, whether the buffer text ACTUALLY changed.

  ⚠ This probe WILL try to insert/replace text in the focused field. Use a
  scratch message (don't send it); it attempts to undo its own edits, but
  clear the box afterwards to be safe.

  Run in Windows PowerShell 5.1:
    powershell -ExecutionPolicy Bypass -File <this>
  Then click into the Discord (or Slack) message box, type "hello world",
  and STAY there (do not click back to the console).
  Results -> \\wsl.localhost\Ubuntu\tmp\oc-ia2-probe.log
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using Accessibility;

// ── IA2 COM interfaces (declared to the vtable slot we call; unused slots
//    kept in order so the layout is correct). ─────────────────────────────
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

[ComImport, Guid("A59AA09A-7011-4b65-939D-32B1FB5547E3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAccessibleEditableText {
  [PreserveSig] int copyText(int startOffset, int endOffset);
  [PreserveSig] int deleteText(int startOffset, int endOffset);
  [PreserveSig] int insertText(int offset, [MarshalAs(UnmanagedType.BStr)] ref string text);
  [PreserveSig] int cutText(int startOffset, int endOffset);
  [PreserveSig] int pasteText(int offset);
  [PreserveSig] int replaceText(int startOffset, int endOffset, [MarshalAs(UnmanagedType.BStr)] ref string text);
  [PreserveSig] int setAttributes(int startOffset, int endOffset, [MarshalAs(UnmanagedType.BStr)] ref string attributes);
}

public static class Ia2Probe {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, out IAccessible acc);
  static Guid IID_IAccessible = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
  static Guid IID_IA2 = new Guid("E89F726E-C4F4-4c19-BB19-B647D7FA8478");
  static Guid IID_IAText = new Guid("4E747BE5-2052-4265-8BF7-EB40A26E2A96");
  static Guid IID_IAEdit = new Guid("A59AA09A-7011-4b65-939D-32B1FB5547E3");
  const uint OBJID_CLIENT = 0xFFFFFFFC;
  const int STATE_FOCUSED = 0x4;

  static System.Collections.Generic.List<IntPtr> Renderers(IntPtr top) {
    var list = new System.Collections.Generic.List<IntPtr>();
    EnumChildWindows(top, (h, l) => {
      var sb = new StringBuilder(160); GetClassName(h, sb, sb.Capacity);
      if (sb.ToString() == "Chrome_RenderWidgetHostHWND") list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible c, int start, int count, [Out] object[] children, out int obtained);
  static int StateOf(IAccessible a) { try { var s = a.get_accState(0); if (s is int) return (int)s; } catch { } return 0; }
  static int RoleOf(IAccessible a) { try { var r = a.get_accRole(0); if (r is int) return (int)r; } catch { } return -1; }
  static string NameOf(IAccessible a) { try { return a.get_accName(0); } catch { return null; } }
  static string Trunc(string s, int m) {
    if (s == null) return "<null>";
    s = s.Replace("\r"," ").Replace("\n"," ");
    return s.Length > m ? s.Substring(0, m) + "…" : s;
  }

  // DFS from a node collecting every descendant that exposes IAccessibleText
  // (direct QI or via IServiceProvider→IA2), so we can find the text leaf even
  // when accFocus lands on a container.
  static void FindTextNodes(IAccessible acc, int depth, System.Collections.Generic.List<IAccessible> hits, StringBuilder trace, int[] budget) {
    if (acc == null || depth > 14 || budget[0] <= 0) return;
    budget[0]--;
    string how; var t = QI(acc, typeof(IAccessibleText), out how);
    if (t != null) {
      hits.Add(acc);
      if (trace.Length < 3000) trace.AppendLine("    [text-iface] depth=" + depth + " role=0x" + RoleOf(acc).ToString("x") + " (" + how + ") name='" + Trunc(NameOf(acc), 28) + "'");
    }
    int cc = 0; try { cc = acc.accChildCount; } catch { }
    if (cc <= 0 || cc > 400) return;
    object[] kids = new object[cc]; int got = 0;
    try { AccessibleChildren(acc, 0, cc, kids, out got); } catch { return; }
    for (int i = 0; i < got; i++) { var ia = kids[i] as IAccessible; if (ia != null) FindTextNodes(ia, depth + 1, hits, trace, budget); }
  }

  // Drill accFocus to the deepest focused IAccessible in the foreground app.
  static IAccessible FindFocusedNode(out string where) {
    where = "";
    IntPtr fg = GetForegroundWindow();
    int pid; GetWindowThreadProcessId(fg, out pid);
    string proc = ""; try { proc = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { }
    var rends = Renderers(fg);
    where = "proc=" + proc + " renderers=" + rends.Count;
    IAccessible bestFocused = null;
    foreach (var rh in rends) {
      IAccessible root;
      if (AccessibleObjectFromWindow(rh, OBJID_CLIENT, ref IID_IAccessible, out root) != 0 || root == null) continue;
      IAccessible cur = root;
      for (int i = 0; i < 40; i++) {
        object f = null; try { f = cur.accFocus; } catch { break; }
        var fa = f as IAccessible;
        if (fa != null && fa != cur) { cur = fa; continue; }
        break;
      }
      if ((StateOf(cur) & STATE_FOCUSED) != 0) { bestFocused = cur; break; }
      if (bestFocused == null) bestFocused = cur;   // fall back to deepest even if state bit missing
    }
    return bestFocused;
  }

  // Obtain IAccessibleText / IAccessibleEditableText from a node — try a
  // direct QI first, then the IServiceProvider→IA2 route.
  static object QI(object node, Type wanted, out string how) {
    how = "";
    bool wantText = (wanted == typeof(IAccessibleText));
    Guid wantIid = wantText ? IID_IAText : IID_IAEdit;
    // 1. direct cast (QueryInterface on the node's RCW)
    try {
      if (wantText) { var x = node as IAccessibleText; if (x != null) { how = "direct-QI"; return x; } }
      else { var x = node as IAccessibleEditableText; if (x != null) { how = "direct-QI"; return x; } }
    } catch {}
    var sp = node as IServiceProvider;
    if (sp == null) { how = "no-IServiceProvider"; return null; }
    // 2. CANONICAL: QueryService(serviceGuid=IID_IAccessible2, riid=target).
    try {
      IntPtr p; int hr = sp.QueryService(ref IID_IA2, ref wantIid, out p);
      if (hr == 0 && p != IntPtr.Zero) {
        object o = System.Runtime.InteropServices.Marshal.GetObjectForIUnknown(p);
        System.Runtime.InteropServices.Marshal.Release(p);
        if (wantText) { var x = o as IAccessibleText; if (x != null) { how = "QueryService(riid)"; return x; } }
        else { var x = o as IAccessibleEditableText; if (x != null) { how = "QueryService(riid)"; return x; } }
      }
    } catch {}
    // 3. QueryService(IID_IAccessible2) then QI for the satellite.
    try {
      IntPtr pIA2; int hr = sp.QueryService(ref IID_IA2, ref IID_IA2, out pIA2);
      if (hr != 0 || pIA2 == IntPtr.Zero) { how = "QS(IA2) hr=0x" + hr.ToString("x8"); return null; }
      object ia2 = System.Runtime.InteropServices.Marshal.GetObjectForIUnknown(pIA2);
      System.Runtime.InteropServices.Marshal.Release(pIA2);
      if (wantText) { var x = ia2 as IAccessibleText; if (x != null) { how = "via-IA2-QI"; return x; } }
      else { var x = ia2 as IAccessibleEditableText; if (x != null) { how = "via-IA2-QI"; return x; } }
      how = "IA2-ok-no-iface";
      return null;
    } catch (Exception ex) { how = "ex:" + ex.Message; return null; }
  }

  public static string Run() {
    var sb = new StringBuilder();
    string where; IAccessible focused = null;
    try { focused = FindFocusedNode(out where); } catch (Exception ex) { return "FindFocusedNode threw: " + ex.Message; }
    sb.AppendLine(where);
    if (focused == null) return sb.ToString() + "no focused node (not a Chromium/Electron field, or a11y tree not woken)";
    sb.AppendLine("focused node: role=0x" + RoleOf(focused).ToString("x") + " name='" + Trunc(NameOf(focused), 28) + "'");

    // The focused node is usually a container — hunt its subtree for the node
    // that actually exposes IAccessibleText, then test THAT one.
    var hits = new System.Collections.Generic.List<IAccessible>();
    var trace = new StringBuilder(); int[] budget = { 600 };
    FindTextNodes(focused, 0, hits, trace, budget);
    sb.AppendLine("nodes exposing IAccessibleText under focused: " + hits.Count);
    sb.Append(trace.ToString());
    if (hits.Count == 0) { sb.AppendLine("→ no IAccessibleText anywhere under the focused node — Chromium doesn't hand us a driveable text interface here."); return sb.ToString(); }

    // Pick the candidate with the most text (the editor body, not a label).
    IAccessible node = hits[0]; string nodeTxt = "";
    foreach (var h in hits) { var ht = (IAccessibleText)QI(h, typeof(IAccessibleText), out where); string tx = null; try { int nn; ht.get_nCharacters(out nn); ht.get_text(0, -1, out tx); } catch { } if (tx != null && tx.Length >= nodeTxt.Length) { node = h; nodeTxt = tx; } }
    sb.AppendLine("→ testing node: role=0x" + RoleOf(node).ToString("x") + " text='" + Trunc(nodeTxt, 50) + "'");

    string howT, howE;
    var t = (IAccessibleText)QI(node, typeof(IAccessibleText), out howT);
    var e = (IAccessibleEditableText)QI(node, typeof(IAccessibleEditableText), out howE);
    sb.AppendLine("IAccessibleText:         " + (t != null ? "YES (" + howT + ")" : "no (" + howT + ")"));
    sb.AppendLine("IAccessibleEditableText: " + (e != null ? "YES (" + howE + ")" : "no (" + howE + ")"));

    // ── IAccessibleText: read + caret control ──
    if (t != null) {
      int nChars = -1, caret = -1, hr;
      hr = t.get_nCharacters(out nChars); sb.AppendLine("  get_nCharacters -> hr=0x" + hr.ToString("x8") + " n=" + nChars);
      hr = t.get_caretOffset(out caret); sb.AppendLine("  get_caretOffset -> hr=0x" + hr.ToString("x8") + " caret=" + caret);
      string txt = null; hr = t.get_text(0, -1, out txt); sb.AppendLine("  get_text(0,-1)  -> hr=0x" + hr.ToString("x8") + " text='" + Trunc(txt, 60) + "'");
      int selS, selE; hr = t.get_selection(0, out selS, out selE); sb.AppendLine("  get_selection   -> hr=0x" + hr.ToString("x8") + " [" + selS + "," + selE + "]");
      if (nChars > 0) {
        int target = Math.Max(0, nChars - 1);
        hr = t.setCaretOffset(target); sb.AppendLine("  setCaretOffset(" + target + ") -> hr=0x" + hr.ToString("x8"));
        int caret2 = -1; t.get_caretOffset(out caret2);
        sb.AppendLine("    caret after set = " + caret2 + (caret2 == target ? "  ✓ MOVED" : "  ✗ (no move)"));
      }
    }

    // ── IAccessibleEditableText: the real question ──
    if (e != null) {
      string before = null; if (t != null) t.get_text(0, -1, out before);
      int nb = (before == null ? 0 : before.Length);
      // insertText at end
      string ins = "«IA2»"; int hr = e.insertText(nb, ref ins);
      string afterI = null; if (t != null) t.get_text(0, -1, out afterI);
      bool changedI = (afterI != null && before != null && afterI != before);
      sb.AppendLine("  insertText(end,'«IA2»') -> hr=0x" + hr.ToString("x8") + (changedI ? "  ✓ TEXT CHANGED" : "  ✗ (no change)"));
      sb.AppendLine("    after='" + Trunc(afterI, 70) + "'");
      // undo our insert if it took
      if (changedI) { try { e.deleteText(nb, (afterI == null ? nb : afterI.Length)); } catch {} }
      // replaceText whole buffer
      string rep = "«IA2-REPLACED»"; hr = e.replaceText(0, (nb > 0 ? nb : -1), ref rep);
      string afterR = null; if (t != null) t.get_text(0, -1, out afterR);
      bool changedR = (afterR != null && afterR.IndexOf("IA2-REPLACED") >= 0);
      sb.AppendLine("  replaceText(all)        -> hr=0x" + hr.ToString("x8") + (changedR ? "  ✓ TEXT CHANGED" : "  ✗ (no change)"));
      sb.AppendLine("    after='" + Trunc(afterR, 70) + "'");
      // restore original if replace took
      if (changedR && before != null) { try { string b2 = before; e.replaceText(0, (afterR == null ? 0 : afterR.Length), ref b2); } catch {} }
      sb.AppendLine("  (probe attempted to undo its own edits — clear the box if anything is left)");
    }
    return sb.ToString();
  }
}
"@ -ReferencedAssemblies System, System.Core, Accessibility

$logWin = "\\wsl.localhost\Ubuntu\tmp\oc-ia2-probe.log"
function Say($m) { Write-Host $m; try { $m | Out-File -FilePath $logWin -Append -Encoding utf8 } catch { } }
try { "" | Out-File -FilePath $logWin -Encoding utf8 } catch { }

# Register as a UIA event client so Chromium builds its a11y tree (same
# non-intrusive wake the shim uses; no global SPI_SETSCREENREADER).
$handler = [System.Windows.Automation.AutomationFocusChangedEventHandler]{ param($s, $e) }
try { [System.Windows.Automation.Automation]::AddAutomationFocusChangedEventHandler($handler) } catch { Say ("focus-handler register failed: " + $_.Exception.Message) }

Write-Host ""
Write-Host "  >>> Click into the Discord/Slack message box, type 'hello world', and STAY. <<<"
Write-Host "  >>> The probe will try to insert/replace text there. Use a scratch message. <<<"
for ($c = 12; $c -gt 0; $c--) { Write-Host "     starting in $c..."; Start-Sleep -Seconds 1 }

Say ("IA2 write/caret probe at " + (Get-Date -Format HH:mm:ss))
try { Say ([Ia2Probe]::Run()) } catch { Say ("Run() threw: " + $_.Exception.Message) }
Say ("done at " + (Get-Date -Format HH:mm:ss))

try { [System.Windows.Automation.Automation]::RemoveAutomationFocusChangedEventHandler($handler) } catch { }
Write-Host "`nDone. Results are in the WSL log: /tmp/oc-ia2-probe.log"
