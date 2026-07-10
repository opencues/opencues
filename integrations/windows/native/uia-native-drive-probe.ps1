<#
  Native-UIA DRIVE probe - the follow-up to uia-native-probe.ps1, which
  found Chromium/Electron (Discord) serving fw='Chrome' with TextPattern,
  TextPattern2, TextEditPattern AND ValuePattern to a native IUIAutomation
  client (the legacy managed API saw none of this).

  Availability flags can lie, so this probe DRIVES the patterns on the
  focused element and reports what actually happens:
    1. ValuePattern: get_CurrentValue + get_CurrentIsReadOnly
       (also cross-checks the property route - a vtable sanity check)
    2. TextPattern:  DocumentRange.GetText, GetSelection
    3. TextPattern2: GetCaretRange -> caret offset
    4. CARET MOVE:   collapsed end-range Select() -> re-read caret
    5. WRITE:        ValuePattern.SetValue(marker) -> re-read -> restore
       (only if not read-only; uses your typed scratch text)

  If 4 and 5 pass on Discord, the whole MSAA clipboard-paste dance can be
  replaced by absolute SetValue writes + real caret control - Electron
  apps become first-class citizens like Notepad.

  Run in Windows PowerShell 5.1:
    powershell -ExecutionPolicy Bypass -File <this>
  Click into the DISCORD (or Slack) message box, type "hello world", STAY.
  Results -> \\wsl.localhost\Ubuntu\tmp\oc-uia-drive-probe.log
#>
$ErrorActionPreference = 'Continue'

Add-Type @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct tagPOINT { public int x; public int y; }

// ── Partial IUIAutomation (vtable order per UIAutomationClient.idl) ──
[ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomation {
  [PreserveSig] int CompareElements(IntPtr el1, IntPtr el2, out int areSame);
  [PreserveSig] int CompareRuntimeIds(IntPtr r1, IntPtr r2, out int areSame);
  [PreserveSig] int GetRootElement(out IUIAutomationElement root);
  [PreserveSig] int ElementFromHandle(IntPtr hwnd, out IUIAutomationElement element);
  [PreserveSig] int ElementFromPoint(tagPOINT pt, out IUIAutomationElement element);
  [PreserveSig] int GetFocusedElement(out IUIAutomationElement element);
}

// ── Partial IUIAutomationElement (through GetCurrentPattern, slot 14) ──
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
  [PreserveSig] int GetCurrentPropertyValueEx(int propertyId, int ignoreDefault, [MarshalAs(UnmanagedType.Struct)] out object retVal);
  [PreserveSig] int GetCachedPropertyValue(int propertyId, [MarshalAs(UnmanagedType.Struct)] out object retVal);
  [PreserveSig] int GetCachedPropertyValueEx(int propertyId, int ignoreDefault, [MarshalAs(UnmanagedType.Struct)] out object retVal);
  [PreserveSig] int GetCurrentPatternAs(int patternId, ref Guid riid, out IntPtr patternObject);
  [PreserveSig] int GetCachedPatternAs(int patternId, ref Guid riid, out IntPtr patternObject);
  [PreserveSig] int GetCurrentPattern(int patternId, [MarshalAs(UnmanagedType.IUnknown)] out object patternObject);
}

// ── IUIAutomationValuePattern ──
[ComImport, Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationValuePattern {
  [PreserveSig] int SetValue([MarshalAs(UnmanagedType.BStr)] string val);
  [PreserveSig] int get_CurrentValue([MarshalAs(UnmanagedType.BStr)] out string retVal);
  [PreserveSig] int get_CurrentIsReadOnly(out int retVal);
  [PreserveSig] int get_CachedValue([MarshalAs(UnmanagedType.BStr)] out string retVal);
  [PreserveSig] int get_CachedIsReadOnly(out int retVal);
}

// ── IUIAutomationTextRange (18 slots; unused ones declared for layout) ──
[ComImport, Guid("a543cc6a-f4ae-494b-8239-c814481187a8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationTextRange {
  [PreserveSig] int Clone(out IUIAutomationTextRange clonedRange);
  [PreserveSig] int Compare(IUIAutomationTextRange range, out int areSame);
  [PreserveSig] int CompareEndpoints(int srcEndpoint, IUIAutomationTextRange range, int targetEndpoint, out int compValue);
  [PreserveSig] int ExpandToEnclosingUnit(int textUnit);
  [PreserveSig] int FindAttribute(int attr, [MarshalAs(UnmanagedType.Struct)] object val, int backward, out IUIAutomationTextRange found);
  [PreserveSig] int FindText([MarshalAs(UnmanagedType.BStr)] string text, int backward, int ignoreCase, out IUIAutomationTextRange found);
  [PreserveSig] int GetAttributeValue(int attr, [MarshalAs(UnmanagedType.Struct)] out object value);
  [PreserveSig] int GetBoundingRectangles(out IntPtr boundingRects);
  [PreserveSig] int GetEnclosingElement(out IUIAutomationElement enclosingElement);
  [PreserveSig] int GetText(int maxLength, [MarshalAs(UnmanagedType.BStr)] out string text);
  [PreserveSig] int Move(int unit, int count, out int moved);
  [PreserveSig] int MoveEndpointByUnit(int endpoint, int unit, int count, out int moved);
  [PreserveSig] int MoveEndpointByRange(int srcEndpoint, IUIAutomationTextRange range, int targetEndpoint);
  [PreserveSig] int Select();
  [PreserveSig] int AddToSelection();
  [PreserveSig] int RemoveFromSelection();
  [PreserveSig] int ScrollIntoView(int alignToTop);
  [PreserveSig] int GetChildren(out IntPtr children);
}

// ── IUIAutomationTextPattern (+2 = TextPattern2) ──
[ComImport, Guid("32eba289-3583-42c9-9c59-3b6d9a1e9b6a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationTextPattern {
  [PreserveSig] int RangeFromPoint(tagPOINT pt, out IUIAutomationTextRange range);
  [PreserveSig] int RangeFromChild(IUIAutomationElement child, out IUIAutomationTextRange range);
  [PreserveSig] int GetSelection(out IntPtr ranges);
  [PreserveSig] int GetVisibleRanges(out IntPtr ranges);
  [PreserveSig] int get_DocumentRange(out IUIAutomationTextRange range);
  [PreserveSig] int get_SupportedTextSelection(out int supportedTextSelection);
}

[ComImport, Guid("506a921a-fcc9-409f-b23b-37eb74106872"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationTextPattern2 {
  [PreserveSig] int RangeFromPoint(tagPOINT pt, out IUIAutomationTextRange range);
  [PreserveSig] int RangeFromChild(IUIAutomationElement child, out IUIAutomationTextRange range);
  [PreserveSig] int GetSelection(out IntPtr ranges);
  [PreserveSig] int GetVisibleRanges(out IntPtr ranges);
  [PreserveSig] int get_DocumentRange(out IUIAutomationTextRange range);
  [PreserveSig] int get_SupportedTextSelection(out int supportedTextSelection);
  [PreserveSig] int RangeFromAnnotation(IUIAutomationElement annotation, out IUIAutomationTextRange range);
  [PreserveSig] int GetCaretRange(out int isActive, out IUIAutomationTextRange range);
}

public static class UiaDrive {
  static Guid CLSID_CUIAutomation8 = new Guid("E22AD333-B25F-460C-83D0-0581107395C9");
  static Guid CLSID_CUIAutomation  = new Guid("FF48DBA4-60EF-4201-AA87-54103EEF594E");

  const int UIA_ValuePatternId = 10002;
  const int UIA_TextPatternId  = 10014;
  const int UIA_TextPattern2Id = 10024;
  const int EP_Start = 0;
  const int EP_End   = 1;

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
  static string Trunc(string s, int m) {
    if (s == null) return "<null>";
    s = s.Replace("\r", " ").Replace("\n", " ");
    return s.Length > m ? s.Substring(0, m) + "..." : s;
  }

  // Caret offset = length of (docRange with End moved to caret's Start).
  static int OffsetOf(IUIAutomationTextPattern tp, IUIAutomationTextRange target) {
    try {
      IUIAutomationTextRange doc;
      if (tp.get_DocumentRange(out doc) != 0 || doc == null) return -1;
      IUIAutomationTextRange r;
      if (doc.Clone(out r) != 0 || r == null) return -1;
      if (r.MoveEndpointByRange(EP_End, target, EP_Start) != 0) return -1;
      string t;
      if (r.GetText(-1, out t) != 0 || t == null) return -1;
      return t.Length;
    } catch { return -1; }
  }

  public static string Run(bool tryWrite) {
    var sb = new System.Text.StringBuilder();
    IUIAutomationElement el;
    int hr = Uia().GetFocusedElement(out el);
    if (hr != 0 || el == null) return "GetFocusedElement hr=0x" + hr.ToString("x8");

    string procName = "";
    try {
      int pid = 0; int.TryParse(PropS(el, 30002), out pid);
      if (pid > 0) procName = System.Diagnostics.Process.GetProcessById(pid).ProcessName;
    } catch { }
    sb.AppendLine("focused: proc=" + procName + " ct=" + PropS(el, 30003) + " fw='" + PropS(el, 30024) + "' name='" + Trunc(PropS(el, 30005), 26) + "'");

    // 1. ValuePattern
    IUIAutomationValuePattern vp = null;
    object po;
    hr = el.GetCurrentPattern(UIA_ValuePatternId, out po);
    if (hr == 0 && po != null) vp = po as IUIAutomationValuePattern;
    if (vp == null) {
      sb.AppendLine("ValuePattern: NOT SERVED (hr=0x" + hr.ToString("x8") + ")");
    } else {
      string cur; int ro = 1;
      int h1 = vp.get_CurrentValue(out cur);
      int h2 = vp.get_CurrentIsReadOnly(out ro);
      string propVal = Trunc(PropS(el, 30045), 30);
      sb.AppendLine("ValuePattern: value='" + Trunc(cur, 30) + "' (hr=0x" + h1.ToString("x8") + ") readonly=" + (ro != 0) + " (hr=0x" + h2.ToString("x8") + ")");
      sb.AppendLine("  vtable cross-check vs property route: '" + propVal + "' -> " + ((Trunc(cur, 30) == propVal) ? "MATCH (vtable sane)" : "MISMATCH (vtable suspect!)"));
    }

    // 2. TextPattern
    IUIAutomationTextPattern tp = null;
    hr = el.GetCurrentPattern(UIA_TextPatternId, out po);
    if (hr == 0 && po != null) tp = po as IUIAutomationTextPattern;
    if (tp == null) {
      sb.AppendLine("TextPattern: NOT SERVED (hr=0x" + hr.ToString("x8") + ")");
      return sb.ToString();
    }
    IUIAutomationTextRange doc;
    hr = tp.get_DocumentRange(out doc);
    string docText = null; int docLen = -1;
    if (hr == 0 && doc != null) {
      if (doc.GetText(-1, out docText) == 0 && docText != null) docLen = docText.Length;
    }
    sb.AppendLine("TextPattern: DocumentRange.GetText -> '" + Trunc(docText, 40) + "' len=" + docLen);

    // 3. TextPattern2 -> caret
    IUIAutomationTextPattern2 tp2 = null;
    hr = el.GetCurrentPattern(UIA_TextPattern2Id, out po);
    if (hr == 0 && po != null) tp2 = po as IUIAutomationTextPattern2;
    int caretBefore = -1;
    if (tp2 == null) {
      sb.AppendLine("TextPattern2: NOT SERVED (hr=0x" + hr.ToString("x8") + ")");
    } else {
      int active; IUIAutomationTextRange caret;
      hr = tp2.GetCaretRange(out active, out caret);
      if (hr == 0 && caret != null) {
        caretBefore = OffsetOf(tp, caret);
        sb.AppendLine("TextPattern2: GetCaretRange active=" + (active != 0) + " caretOffset=" + caretBefore);
      } else {
        sb.AppendLine("TextPattern2: GetCaretRange hr=0x" + hr.ToString("x8"));
      }
    }

    // 4. CARET MOVE: move caret to offset 0 via collapsed start-range Select(),
    //    then back to end. (Start, not end - if the caret is already at the
    //    end after typing, a move to 0 is unambiguous proof of control.)
    try {
      IUIAutomationTextRange startR;
      if (doc.Clone(out startR) == 0 && startR != null) {
        startR.MoveEndpointByRange(EP_End, doc, EP_Start);   // collapse to START
        hr = startR.Select();
        System.Threading.Thread.Sleep(120);
        int after = -1;
        if (tp2 != null) {
          int a2; IUIAutomationTextRange c2;
          if (tp2.GetCaretRange(out a2, out c2) == 0 && c2 != null) after = OffsetOf(tp, c2);
        }
        sb.AppendLine("CaretMove: Select(collapsed@0) hr=0x" + hr.ToString("x8") + " caretAfter=" + after + ((after == 0) ? "  -> MOVED (control confirmed)" : "  -> did not land at 0"));
        // restore to end
        IUIAutomationTextRange endR;
        if (doc.Clone(out endR) == 0 && endR != null) {
          endR.MoveEndpointByRange(EP_Start, doc, EP_End);
          endR.Select();
        }
      }
    } catch (Exception ex) { sb.AppendLine("CaretMove threw: " + ex.Message); }

    // 5. WRITE via ValuePattern.SetValue (only when asked + not readonly)
    if (tryWrite && vp != null) {
      int ro = 1; vp.get_CurrentIsReadOnly(out ro);
      if (ro != 0) {
        sb.AppendLine("SetValue: skipped (read-only)");
      } else {
        string before; vp.get_CurrentValue(out before);
        string marker = (before == null ? "" : before) + " [UIA-WRITE]";
        hr = vp.SetValue(marker);
        System.Threading.Thread.Sleep(250);
        string after; vp.get_CurrentValue(out after);
        bool changed = (after != null && after.IndexOf("[UIA-WRITE]") >= 0);
        sb.AppendLine("SetValue: hr=0x" + hr.ToString("x8") + (changed ? "  -> TEXT CHANGED (write path confirmed!)" : "  -> no change (value='" + Trunc(after, 30) + "')"));
        // read back via TextPattern too (the read the shim would use)
        string tpText = null;
        IUIAutomationTextRange d2;
        if (tp.get_DocumentRange(out d2) == 0 && d2 != null) d2.GetText(-1, out tpText);
        sb.AppendLine("  TextPattern sees: '" + Trunc(tpText, 40) + "'");
        // restore
        if (changed && before != null) { vp.SetValue(before); }
      }
    }
    return sb.ToString();
  }
}
"@ -ReferencedAssemblies System, System.Core

$logWin = "\\wsl.localhost\Ubuntu\tmp\oc-uia-drive-probe.log"
function Say($m) {
  Write-Host $m
  try { $m | Out-File -FilePath $logWin -Append -Encoding utf8 } catch { }
}
try { "" | Out-File -FilePath $logWin -Encoding utf8 } catch { }

Write-Host ""
Write-Host "  >>> Click into the DISCORD (or Slack) message box, type 'hello world', STAY. <<<"
Write-Host "  >>> The probe will move the caret and write a [UIA-WRITE] marker (restored). <<<"
for ($c = 10; $c -gt 0; $c--) {
  Write-Host "     starting in $c..."
  Start-Sleep -Seconds 1
}

Say ("native-UIA drive probe at " + (Get-Date -Format HH:mm:ss))
try { Say ([UiaDrive]::Run($true)) } catch { Say ("Run threw: " + $_.Exception.Message) }
Say ("done at " + (Get-Date -Format HH:mm:ss))
Write-Host ""
Write-Host "Done. Results -> /tmp/oc-uia-drive-probe.log"
