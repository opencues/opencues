// OpenCues Windows shim - the thin native half of the Windows
// integration. Runs on Windows; does NOT contain any OpenCues logic.
// Its whole job:
//
//   1. Watch the currently-focused text field via UI Automation.
//   2. Stream its text (+ focus/blur) to the WSL-side daemon over a
//      TCP socket (127.0.0.1:<port>, forwarded into WSL by WSL2).
//   3. Apply `set-text` commands the daemon sends back (LLM
//      substitutions, blank fills). Write ladder, smoothest first:
//      Edit/RichEdit HWNDs -> EM_SETSEL+EM_REPLACESEL span splice
//      (undo-preserving, verified by read-back); other UIA fields ->
//      ValuePattern.SetValue; Electron/MSAA -> prefix+suffix-diffed
//      key burst (Left/Backspace/Ctrl+V) with Ctrl+A+paste fallback.
//
// Phase 1: read/write only - no keyboard hook, no overlay. The daemon
// runs the host as `supportsCycling:false`, so nothing needs chord
// interception or colour. Phase 2 adds a WH_KEYBOARD_LL hook + a
// layered click-through overlay here and flips supportsCycling.
//
// Designed to compile two ways:
//   * `Add-Type` inside Windows PowerShell 5.1 (.NET Framework) - the
//     default, no SDK required (see OpenCuesWindows.ps1).
//   * A normal `dotnet build` against a net48 / windows csproj later.
//
// UIA is a cross-process COM API; all UIA calls run on a dedicated MTA
// thread. The socket reader runs on its own thread and only enqueues
// (no COM), so its apartment doesn't matter.

using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using Accessibility;   // MSAA/IA2 IAccessible - the Chromium/Electron read path

namespace OpenCues
{
    public static class WindowsShim
    {
        // Foreground processes we never attach to. Browsers: the chrome
        // extension is the better surface there (and the user asked for
        // local-OC precedence, handled later). Terminals: their UIA
        // surface is a screen buffer, not an editable field, and any
        // WSL OpenCues host already lives inside them.
        static readonly HashSet<string> DenyApps = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "chrome", "msedge", "brave", "opera", "vivaldi", "firefox",
            "WindowsTerminal", "conhost", "cmd", "powershell", "pwsh",
            "OpenConsole", "mintty", "wt",
        };

        // Field name/id tokens that mark a credential / sensitive field.
        static readonly string[] SensitiveTokens = new[]
        {
            "password", "passwd", "pwd", "otp", "one-time", "onetime",
            "cvv", "cvc", "cardnumber", "card-number", "ccnumber", "secret",
            "pin", "ssn", "socialsecurity",
        };

        static volatile bool _running = true;
        static volatile bool _enabled = true;
        // Read by the tray app (cross-thread; volatile is enough for
        // single-writer string publication).
        public static volatile string StatusLine = "starting";
        public static volatile string ConfigPathWin = "";   // daemon-reported, Windows-openable
        public static volatile string LogPathWin = "";
        static readonly ConcurrentQueue<string> _incoming = new ConcurrentQueue<string>();

        static TcpClient _client;
        static NetworkStream _stream;
        static readonly object _sendLock = new object();

        // Focus + mirror state (touched only on the poll thread).
        static int _lastElementId = int.MinValue;
        static int _lastDiagId = int.MinValue;   // last element we logged a skip diagnostic for
        static int _lastCatalogId = int.MinValue;   // last element we cataloged as a surface
        static readonly HashSet<string> _seenSurfaces = new HashSet<string>(StringComparer.Ordinal);
        static string _lastSentText = null;
        static string _expectedEcho = null;   // value we just wrote; ignore its read-back
        static bool _attached = false;

        // How the current attachment is read/written: UIA (native Win32 /
        // WinForms / WPF, via ValuePattern/TextPattern) or MSAA/IA2
        // (Chromium/Electron editors, via oleacc + clipboard-paste write).
        enum AttachMode { None, Uia, Msaa }
        static AttachMode _attachMode = AttachMode.None;

        // Deferred MSAA paste (see ApplySetText): the latest pending text + the
        // tick it arrived, flushed by MaybeFlushMsaaPaste once the set-text
        // stream is quiet, so a whole loading animation is one paste.
        static string _pendingMsaaText = null;
        static int _pendingMsaaAtTick = 0;
        const int MSAA_PASTE_QUIET_MS = 120;

        static int _port;
        static string _host;
        static int _pollMs = 150;

        static Thread _pollThreadRef;

        // Start the shim on a background MTA thread and return immediately.
        // Used by the tray app, which owns the WinForms STA UI thread - the
        // shim's UIA calls need MTA, so they live on their own thread.
        public static void Start(string host, int port)
        {
            _host = string.IsNullOrEmpty(host) ? "127.0.0.1" : host;
            _port = port;
            _running = true;
            _enabled = true;
            var envPoll = Environment.GetEnvironmentVariable("OPENCUES_WIN_POLL_MS");
            int p;
            if (!string.IsNullOrEmpty(envPoll) && int.TryParse(envPoll, out p) && p >= 30) _pollMs = p;
            Console.WriteLine("OpenCues Windows shim starting -> " + _host + ":" + _port);
            _pollThreadRef = new Thread(PollThread);
            _pollThreadRef.IsBackground = true;
            _pollThreadRef.SetApartmentState(ApartmentState.MTA);
            _pollThreadRef.Start();
        }

        // Standalone / Program.cs path: start then block until stopped.
        public static void Run(string host, int port)
        {
            Start(host, port);
            if (_pollThreadRef != null) _pollThreadRef.Join();
        }

        public static void Stop()
        {
            _running = false;
            try { if (_wakeHandler != null) { Automation.RemoveAutomationFocusChangedEventHandler(_wakeHandler); _wakeHandler = null; } } catch { }
            try { Disconnect(); } catch { }
        }

        // Wake signal for Chromium/Electron accessibility. Chromium builds its
        // MSAA/IA2 tree only when it detects an assistive-technology client.
        // Registering a no-op UIA focus-changed handler makes this process a
        // live UIA event client - the lightweight, non-intrusive "an AT is
        // listening" signal. Combined with the per-renderer OBJID_CLIENT poke
        // in TryReadFocusedElectron this reliably wakes the tree WITHOUT the
        // global SPI_SETSCREENREADER flag (verified against Discord: the
        // per-window poke reads identically with SPI off, so we never flip
        // other apps into system-wide screen-reader mode).
        static AutomationFocusChangedEventHandler _wakeHandler;
        static void EnsureWakeSignal()
        {
            if (_wakeHandler != null) return;
            try
            {
                _wakeHandler = (s, e) => { };
                Automation.AddAutomationFocusChangedEventHandler(_wakeHandler);
            }
            catch { _wakeHandler = null; }
        }

        // Pause/resume attaching. When disabled the shim detaches from every
        // field (sends blur) and ignores set-text - nothing reaches the LLM -
        // without tearing down the socket. This is the tray "Enabled" toggle.
        public static void SetEnabled(bool on) { _enabled = on; }
        public static bool Enabled { get { return _enabled; } }
        public static bool Connected { get { return _client != null && _client.Connected; } }

        // --- Main MTA loop: (re)connect, drain commands, poll focus -----
        static void PollThread()
        {
            EnsureWakeSignal();   // make us a UIA event client so Chromium builds its a11y tree
            while (_running)
            {
                if (!EnsureConnected())
                {
                    StatusLine = "waiting for daemon";
                    Thread.Sleep(1000);
                    continue;
                }
                try
                {
                    DrainCommands();
                    MaybeFlushMsaaPaste();   // apply any deferred Electron paste once the stream settles
                    if (_enabled)
                    {
                        PollFocus();
                    }
                    else
                    {
                        LeaveAttached(null);
                        StatusLine = "disabled";
                    }
                }
                catch (Exception ex)
                {
                    // A dropped connection lands here via the send path.
                    Log("warn", "poll error: " + ex.Message);
                    Disconnect();
                }
                Thread.Sleep(_pollMs);
            }
        }

        static bool EnsureConnected()
        {
            if (_client != null && _client.Connected) return true;
            try
            {
                _client = new TcpClient();
                _client.NoDelay = true;
                _client.Connect(_host, _port);
                _stream = _client.GetStream();
                _lastElementId = int.MinValue;
                _lastSentText = null;
                _expectedEcho = null;
                _attached = false;
                _attachMode = AttachMode.None;
                var reader = new Thread(ReaderThread) { IsBackground = true };
                reader.Start(_stream);
                SendRaw("{\"t\":\"hello\",\"version\":\"0.1.0\",\"os\":\"windows\"}");
                Log("info", "shim connected to daemon; watching for text fields (paste-gap=" + _pasteGapMs + "ms)");
                return true;
            }
            catch (Exception ex)
            {
                // Quiet retry - daemon may not be up yet.
                if (_client != null) { try { _client.Close(); } catch { } _client = null; }
                Console.WriteLine("waiting for daemon (" + ex.Message + ") ...");
                return false;
            }
        }

        static void Disconnect()
        {
            try { if (_stream != null) _stream.Close(); } catch { }
            try { if (_client != null) _client.Close(); } catch { }
            _stream = null; _client = null; _attached = false;
            _attachMode = AttachMode.None;
            _pendingMsaaText = null;
            StatusLine = "waiting for daemon";
        }

        // --- Socket reader (no COM - any apartment) ---------------------
        static void ReaderThread(object streamObj)
        {
            var stream = (NetworkStream)streamObj;
            var reader = new StreamReader(stream, new UTF8Encoding(false));
            try
            {
                string line;
                while (_running && (line = reader.ReadLine()) != null)
                {
                    if (line.Length > 0) _incoming.Enqueue(line);
                }
            }
            catch { /* connection dropped - poll loop reconnects */ }
        }

        static void DrainCommands()
        {
            string line;
            while (_incoming.TryDequeue(out line))
            {
                object parsed;
                try { parsed = MiniJson.Parse(line); } catch { continue; }
                var map = parsed as Dictionary<string, object>;
                if (map == null) continue;
                string t = Str(map, "t");
                switch (t)
                {
                    case "welcome":
                        {
                            string cw = Str(map, "cuesHomeWin");
                            string lw = Str(map, "logFileWin");
                            if (!string.IsNullOrEmpty(cw)) ConfigPathWin = cw;
                            if (!string.IsNullOrEmpty(lw)) LogPathWin = lw;
                            StatusLine = "connected";
                            Log("info", "daemon ready (host=" + Str(map, "host") + " v" + Str(map, "hostVersion")
                                + " config=" + ConfigPathWin + ")");
                        }
                        break;
                    case "set-text":
                        ApplySetText(Str(map, "text"));
                        break;
                    case "set-cursor":
                        // Phase 1: caret is assumed at end; nothing to do.
                        break;
                    case "pong":
                        break;
                }
            }
        }

        // --- Focus polling + text streaming -----------------------------
        static void PollFocus()
        {
            AutomationElement el = null;
            try { el = AutomationElement.FocusedElement; } catch { el = null; }

            if (el == null) { LeaveAttached(null); return; }

            int elId;
            string app;
            try
            {
                elId = el.GetRuntimeId() != null ? RuntimeIdHash(el.GetRuntimeId()) : el.GetHashCode();
                app = ProcessName(el);
            }
            catch { return; }

            // Catalog this surface for later allow/deny filtering (dedup'd,
            // metadata only, password/sensitive excluded) - independent of
            // whether we actually attach to it.
            CatalogSurface(el, app, elId);

            // 1. UIA fast path - native Win32 / WinForms / WPF editors with a
            //    writable ValuePattern (or an editable TextPattern).
            if (IsAttachable(el, app))
            {
                StreamAttachment(elId, app, ReadValue(el), AttachMode.Uia);
                return;
            }

            // 2. MSAA/IA2 fallback - non-browser Chromium/Electron editors
            //    (Discord, Slack, Obsidian, ...). UIA sees only an empty
            //    read-only Document shell; the editable text lives in the MSAA
            //    tree behind the Chrome_RenderWidgetHostHWND child. Browsers +
            //    terminals stay deny-listed (the chrome extension owns browser
            //    content, so this never becomes an unfiltered web-page reader).
            //    TryReadFocusedElectron only returns a genuine editable text
            //    field (role TEXT, not read-only, not password/sensitive).
            if (app != null && !DenyApps.Contains(app))
            {
                string mtext; int mnode;
                if (TryReadFocusedElectron(out mtext, out mnode))
                {
                    StreamAttachment(mnode, app, mtext, AttachMode.Msaa);
                    return;
                }
            }

            // 3. Nothing usable. Log why (once per element), then detach.
            if (elId != _lastDiagId && (app == null || !DenyApps.Contains(app)))
            {
                _lastDiagId = elId;
                DiagnoseSkip(el, app);
            }
            LeaveAttached(app);
        }

        // Shared focus/text/blur streaming for both attach modes. `readText`
        // is the field's current text (read via UIA or MSAA); `mode` records
        // how ApplySetText must write it back. A changed element id is a hard
        // buffer boundary: it fires a focus event so the daemon resets buffer
        // state (the canonical multi-buffer trigger - see the integration
        // CLAUDE.md "Multi-buffer state" note).
        static void StreamAttachment(int elId, string app, string readText, AttachMode mode)
        {
            if (elId != _lastElementId)
            {
                _lastElementId = elId;
                _attachMode = mode;
                _lastSentText = readText;
                _expectedEcho = null;
                _attached = true;
                StatusLine = "on: " + (app ?? "text field");
                Log("info", "attached: " + (app ?? "text field") + " ("
                    + (readText == null ? 0 : readText.Length) + " chars, "
                    + (mode == AttachMode.Msaa ? "MSAA" : "UIA") + ")");
                SendRaw("{\"t\":\"focus\",\"app\":" + JStr(app) + ",\"text\":" + JStr(readText)
                    + ",\"cursor\":" + (readText == null ? 0 : readText.Length).ToString(CultureInfo.InvariantCulture) + "}");
                return;
            }

            // Same element - send text only when it changed and it isn't our
            // own write echoing back.
            _attachMode = mode;
            string cur = readText;
            if (cur == null) return;
            if (_expectedEcho != null && cur == _expectedEcho) { _lastSentText = cur; return; }
            if (cur == _lastSentText) return;
            _lastSentText = cur;
            _expectedEcho = null;
            SendRaw("{\"t\":\"text\",\"text\":" + JStr(cur)
                + ",\"cursor\":" + cur.Length.ToString(CultureInfo.InvariantCulture) + "}");
        }

        static void LeaveAttached(string app)
        {
            if (!_attached) { _lastElementId = int.MinValue; if (_enabled) StatusLine = "idle"; return; }
            _attached = false;
            _lastElementId = int.MinValue;
            _lastSentText = null;
            _expectedEcho = null;
            _attachMode = AttachMode.None;
            _pendingMsaaText = null;
            if (_enabled) StatusLine = "idle";
            Log("debug", "detached" + (app != null ? " (now on " + app + ", not attachable)" : ""));
            SendRaw("{\"t\":\"blur\",\"app\":" + JStr(app) + "}");
        }

        // --- UIA read/write ---------------------------------------------
        static string ReadValue(AutomationElement el)
        {
            // Prefer a WRITABLE ValuePattern (native Win32/WinForms/WPF -
            // authoritative + full text). A read-only ValuePattern is often
            // an empty Chromium shell, so fall through to TextPattern (where
            // the real editable text lives once the renderer is woken).
            try
            {
                object vp;
                if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vp) && !((ValuePattern)vp).Current.IsReadOnly)
                    return ((ValuePattern)vp).Current.Value ?? "";
            }
            catch { }
            try
            {
                object tp;
                if (el.TryGetCurrentPattern(TextPattern.Pattern, out tp))
                    return ((TextPattern)tp).DocumentRange.GetText(-1) ?? "";
            }
            catch { }
            // Last resort: a read-only ValuePattern value (better than nothing).
            try
            {
                object vp2;
                if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vp2))
                    return ((ValuePattern)vp2).Current.Value ?? "";
            }
            catch { }
            return null;
        }

        static void ApplySetText(string text)
        {
            if (text == null) return;

            // MSAA-attached (Chromium/Electron): the focused UIA element is an
            // empty shell with no writable pattern, so writes go through the
            // app's own paste path (Ctrl+A + Ctrl+V). Each paste is a visible
            // select-all-replace + clipboard churn, and the BlankLoading
            // animation emits many rapid frames + a final result. So DEFER the
            // paste: stash the latest text and let MaybeFlushMsaaPaste() apply
            // it once the set-text stream goes quiet - collapsing the whole
            // animation into ONE clean paste of the final result.
            if (_attachMode == AttachMode.Msaa)
            {
                _pendingMsaaText = text;
                _pendingMsaaAtTick = Environment.TickCount;
                return;
            }

            AutomationElement el = null;
            try { el = AutomationElement.FocusedElement; } catch { }
            if (el == null) return;
            try
            {
                // Fast path: a writable ValuePattern (Win32 Edit, WinForms,
                // WPF, Notepad, Explorer). Edit-family HWNDs get a surgical
                // span replace (EM_SETSEL + EM_REPLACESEL: no whole-value
                // clobber, caret + undo survive); everything else - and any
                // EM write that fails read-back verification - takes the
                // whole-value SetValue.
                object vp;
                if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vp) && !((ValuePattern)vp).Current.IsReadOnly)
                {
                    _expectedEcho = text;
                    _lastSentText = text;
                    if (TryEmReplaceSel(el, (ValuePattern)vp, text))
                        return;   // verified applied (logged inside)
                    ((ValuePattern)vp).SetValue(text);
                    Log("debug", "applied substitution (" + text.Length + " chars, ValuePattern)");
                    return;
                }
                // Fallback: no writable ValuePattern but a TextPattern is
                // present -> an Electron/Chromium/contenteditable editor
                // (VS Code, Discord, Slack, web text boxes). Write via
                // simulated input: set clipboard, Ctrl+A, Ctrl+V, restore.
                object tp;
                if (el.TryGetCurrentPattern(TextPattern.Pattern, out tp))
                {
                    string oldText = _lastSentText;
                    _expectedEcho = text;
                    _lastSentText = text;
                    PasteReplace(text, oldText);
                    Log("debug", "applied substitution (" + text.Length + " chars, paste)");
                    return;
                }
                Log("warn", "focused field can't be written (no ValuePattern or TextPattern)");
            }
            catch (Exception ex) { Log("warn", "set-text failed: " + ex.Message); }
        }

        // Apply a deferred MSAA paste once the set-text stream has been quiet
        // for MSAA_PASTE_QUIET_MS. Called every poll tick. Loading-animation
        // frames keep resetting _pendingMsaaAtTick, so only the LAST text (the
        // final result) survives the quiet window and gets pasted - one clear +
        // paste instead of one per frame. If focus left the MSAA field
        // meanwhile, the pending paste is dropped (never lands in another app).
        static void MaybeFlushMsaaPaste()
        {
            if (_pendingMsaaText == null) return;
            if (_attachMode != AttachMode.Msaa || !_enabled) { _pendingMsaaText = null; return; }
            if (unchecked(Environment.TickCount - _pendingMsaaAtTick) < MSAA_PASTE_QUIET_MS) return;
            string text = _pendingMsaaText;
            string oldText = _lastSentText;   // field's current content -> backspace count
            _pendingMsaaText = null;
            _expectedEcho = text;
            _lastSentText = text;
            PasteReplace(text, oldText);
            Log("debug", "applied substitution (" + text.Length + " chars, MSAA/paste)");
        }

        // --- Attachability gate -----------------------------------------
        // The browser URL bar (omnibox) is a native Chromium Edit, NOT web
        // content, and the chrome extension can't reach it - so it's the one
        // browser surface the shim owns. Identified by its stable native class
        // 'OmniboxViewViews' (same across chrome/edge/brave and across
        // versions/locales; web content is renderer-drawn and has no such Win32
        // class, so this can never leak page content). It exposes a writable
        // ValuePattern, so it flows through the normal UIA path below.
        static bool IsBrowserOmnibox(AutomationElement el)
        {
            try { return el.Current.ClassName == "OmniboxViewViews"; }
            catch { return false; }
        }

        static bool IsAttachable(AutomationElement el, string app)
        {
            // Deny-listed apps (browsers, terminals) are off-limits - EXCEPT the
            // browser omnibox (see IsBrowserOmnibox). Everything else in a
            // browser stays blocked: this gate AND the MSAA fallback are both
            // deny-list-gated, so web-page content never attaches either way.
            if (app != null && DenyApps.Contains(app) && !IsBrowserOmnibox(el)) return false;
            try
            {
                // Type allowlist: only Edit / Document controls.
                var ct = el.Current.ControlType;
                if (ct != ControlType.Edit && ct != ControlType.Document) return false;

                // Password / sensitive -> never.
                if (el.Current.IsPassword) return false;
                string name = (el.Current.Name ?? "") + " " + (el.Current.AutomationId ?? "");
                string low = name.ToLowerInvariant();
                foreach (var tok in SensitiveTokens)
                    if (low.Contains(tok)) return false;

                // Writable ValuePattern -> fast write path (Win32/WinForms/WPF).
                object vp;
                if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vp))
                {
                    if (!((ValuePattern)vp).Current.IsReadOnly) return true;
                    // Genuinely read-only value control -> skip.
                    return false;
                }
                // No ValuePattern but a TextPattern -> an editable
                // Electron/Chromium/contenteditable editor (VS Code, Discord,
                // Slack, web boxes). Read via TextPattern; write via clipboard
                // paste. (The user has focused it to type, so it's editable;
                // a paste into a truly read-only view harmlessly no-ops.)
                object tp;
                if (el.TryGetCurrentPattern(TextPattern.Pattern, out tp)) return true;
                return false;
            }
            catch { return false; }
        }

        // --- MSAA/IA2 read path (Chromium / Electron editors) ----------
        // Electron apps expose their editable text via MSAA/IA2, not UIA:
        // the focused UIA element is an empty read-only Document shell, but
        // the real text lives in the MSAA tree behind the renderer child
        // window. We poke each Chrome_RenderWidgetHostHWND with OBJID_CLIENT
        // (via oleacc - this is also what wakes Chromium's lazily-built a11y
        // tree), drill accFocus to the focused node, and read it ONLY when it
        // is a genuine editable text field. No global screen-reader flag is
        // set - a per-window poke is enough (verified against Discord: reads
        // identically with SPI_SETSCREENREADER off).
        delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
        [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, out IAccessible acc);
        [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible container, int start, int count, [Out] object[] children, out int obtained);

        static readonly Guid IID_IAccessible = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
        const uint OBJID_CLIENT = 0xFFFFFFFC;
        const int ROLE_STATICTEXT = 0x29;
        const int ROLE_TEXT = 0x2a;               // ROLE_SYSTEM_TEXT - an editable text field
        const int STATE_READONLY = 0x40;
        const int STATE_PROTECTED = 0x20000000;   // password-style field
        const int MSAA_ID_SALT = 0x4D534141;      // 'MSAA' - keep MSAA node ids out of the UIA id space

        static int MsaaRole(IAccessible a) { try { var r = a.get_accRole(0); if (r is int) return (int)r; } catch { } return -1; }
        static int MsaaState(IAccessible a) { try { var s = a.get_accState(0); if (s is int) return (int)s; } catch { } return 0; }
        static string MsaaName(IAccessible a) { try { return a.get_accName(0) ?? ""; } catch { return ""; } }

        static bool IsSensitiveName(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            string low = name.ToLowerInvariant();
            foreach (var tok in SensitiveTokens) if (low.Contains(tok)) return true;
            return false;
        }

        // The focused editable node's text. For a role=TEXT node the whole
        // value is in accValue; fall back to a shallow child walk only when
        // that's empty (some editors expose text as child static-text runs).
        static string ReadFocusedText(IAccessible node)
        {
            try { string v = node.get_accValue(0); if (!string.IsNullOrEmpty(v)) return v; } catch { }
            var sb = new StringBuilder();
            int[] budget = { 400 };
            WalkStaticText(node, 0, sb, budget);
            return sb.ToString();
        }

        static void WalkStaticText(IAccessible acc, int depth, StringBuilder sb, int[] budget)
        {
            if (acc == null || depth > 8 || budget[0] <= 0) return;
            budget[0]--;
            if (MsaaRole(acc) == ROLE_STATICTEXT)
            {
                string nm = MsaaName(acc);
                if (!string.IsNullOrEmpty(nm)) { if (sb.Length > 0) sb.Append(' '); sb.Append(nm); }
            }
            int cc = 0; try { cc = acc.accChildCount; } catch { }
            if (cc <= 0 || cc > 400) return;
            object[] kids = new object[cc]; int got = 0;
            try { AccessibleChildren(acc, 0, cc, kids, out got); } catch { return; }
            for (int i = 0; i < got; i++) { var ia = kids[i] as IAccessible; if (ia != null) WalkStaticText(ia, depth + 1, sb, budget); }
        }

        // Read the FOREGROUND Chromium/Electron window's focused editable
        // field over MSAA. Returns false (don't attach) unless the focused
        // node is a writable, non-sensitive text field. `nodeId` changes when
        // the user moves to a different field (a focus boundary for the
        // daemon's buffer-state reset), and is XOR-salted so it can never
        // collide with a UIA runtime-id hash.
        static bool TryReadFocusedElectron(out string text, out int nodeId)
        {
            text = null; nodeId = 0;
            IntPtr fg = GetForegroundWindow();
            if (fg == IntPtr.Zero) return false;

            var renderers = new List<IntPtr>();
            try
            {
                EnumChildWindows(fg, (h, l) =>
                {
                    var sb = new StringBuilder(160);
                    GetClassName(h, sb, sb.Capacity);
                    if (sb.ToString() == "Chrome_RenderWidgetHostHWND") renderers.Add(h);
                    return true;
                }, IntPtr.Zero);
            }
            catch { }
            if (renderers.Count == 0) return false;   // not a Chromium/Electron window

            string bestText = null; string bestName = ""; int bestLen = -1;
            foreach (var rh in renderers)
            {
                IAccessible root;
                int hr;
                try { Guid iid = IID_IAccessible; hr = AccessibleObjectFromWindow(rh, OBJID_CLIENT, ref iid, out root); }
                catch { continue; }
                if (hr != 0 || root == null) continue;

                // Drill accFocus to the deepest focused node.
                IAccessible cur = root;
                for (int i = 0; i < 40; i++)
                {
                    object f = null;
                    try { f = cur.accFocus; } catch { break; }
                    var fa = f as IAccessible;
                    if (fa != null && fa != cur) { cur = fa; continue; }
                    break;   // null, a child-id leaf, or self -> cur is the focused node
                }

                int role = MsaaRole(cur);
                int state = MsaaState(cur);
                if (role != ROLE_TEXT) continue;               // only editable text fields
                if ((state & STATE_READONLY) != 0) continue;   // read-only view
                if ((state & STATE_PROTECTED) != 0) continue;  // password-style: never read
                string name = MsaaName(cur);
                if (IsSensitiveName(name)) continue;

                string t = ReadFocusedText(cur) ?? "";
                if (t.Length > bestLen) { bestLen = t.Length; bestText = t; bestName = name; }
            }

            if (bestText == null) return false;
            text = bestText;
            unchecked
            {
                int h = 17;
                h = h * 31 + fg.GetHashCode();
                if (!string.IsNullOrEmpty(bestName)) h = h * 31 + bestName.GetHashCode();
                nodeId = h ^ MSAA_ID_SALT;
            }
            return true;
        }

        // Log what a focused-but-skipped field exposes to UIA - so we can
        // see why VS Code / Discord / etc. don't attach.
        static void DiagnoseSkip(AutomationElement el, string app)
        {
            try
            {
                string ct = "?";
                try { ct = el.Current.ControlType.ProgrammaticName; } catch { }
                bool hasVal = false, valRo = false, hasText = false, kbFocus = false, pwd = false;
                try { object o; hasVal = el.TryGetCurrentPattern(ValuePattern.Pattern, out o); if (hasVal) valRo = ((ValuePattern)o).Current.IsReadOnly; } catch { }
                try { object o; hasText = el.TryGetCurrentPattern(TextPattern.Pattern, out o); } catch { }
                try { kbFocus = el.Current.IsKeyboardFocusable; } catch { }
                try { pwd = el.Current.IsPassword; } catch { }
                Log("info", "skip " + (app ?? "?") + " ct=" + ct
                    + " value=" + (hasVal ? (valRo ? "ro" : "rw") : "no")
                    + " text=" + (hasText ? "yes" : "no")
                    + " kbfocus=" + kbFocus + " pwd=" + pwd);
            }
            catch (Exception ex) { Log("debug", "diag failed: " + ex.Message); }
        }

        // --- Surface discovery catalog ---------------------------------
        // Record a deduplicated signature (proc|controlType|className) for every
        // DISTINCT focused surface + how it can be read, so surfaces can be
        // reviewed and allow/deny-filtered later instead of probing apps one at
        // a time. Runs on every focus CHANGE, independent of attachability.
        // Metadata ONLY - never field content; password/sensitive fields are
        // excluded entirely (never even cataloged). Cheap: computes the signature
        // (ct + class read) per focus change; the fuller readability probe runs
        // once per unique surface.
        static void CatalogSurface(AutomationElement el, string app, int elId)
        {
            if (elId == _lastCatalogId) return;   // only on focus change
            _lastCatalogId = elId;
            try
            {
                if (el.Current.IsPassword) return;   // never catalog credential fields
                string ctName;
                try { ctName = el.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""); } catch { return; }
                string cls = ""; try { cls = el.Current.ClassName ?? ""; } catch { }
                string name = ""; try { name = el.Current.Name ?? ""; } catch { }
                string autoId = ""; try { autoId = el.Current.AutomationId ?? ""; } catch { }
                string low = (name + " " + autoId).ToLowerInvariant();
                foreach (var tok in SensitiveTokens) if (low.Contains(tok)) return;   // skip sensitive

                string sig = (app ?? "?") + "|" + ctName + "|" + cls;
                if (!_seenSurfaces.Add(sig)) return;   // already cataloged this session

                bool vpRw = false; string vp = "no";
                try { object o; if (el.TryGetCurrentPattern(ValuePattern.Pattern, out o)) { vpRw = !((ValuePattern)o).Current.IsReadOnly; vp = vpRw ? "rw" : "ro"; } } catch { }
                bool hasTp = false;
                try { object o; if (el.TryGetCurrentPattern(TextPattern.Pattern, out o)) hasTp = true; } catch { }
                bool renderer = HasRendererChild();
                string kind = ClassifySurface(ctName, cls, vpRw, hasTp, renderer);

                SendRaw("{\"t\":\"surface\",\"sig\":" + JStr(sig)
                    + ",\"kind\":" + JStr(kind) + ",\"vp\":" + JStr(vp) + ",\"tp\":" + JStr(hasTp ? "yes" : "no")
                    + ",\"renderer\":" + JStr(renderer ? "yes" : "no") + ",\"proc\":" + JStr(app)
                    + ",\"ct\":" + JStr(ctName) + ",\"cls\":" + JStr(cls) + ",\"name\":" + JStr(Trunc(name, 40)) + "}");
            }
            catch { }
        }

        // Derive how a surface can be read, for the catalog. Order matters:
        // WinUI islands + writable-ValuePattern controls are checked before the
        // Chromium-renderer heuristic.
        static string ClassifySurface(string ctName, string cls, bool vpRw, bool hasTp, bool renderer)
        {
            if (cls != null && (cls.Contains("DesktopChildSiteBridge") || cls.StartsWith("Microsoft.UI.Content"))) return "winui-island (needs drill)";
            if (vpRw) return "uia-writable";
            if (renderer && (ctName == "Document" || ctName == "Pane")) return "electron-msaa";
            if (hasTp) return "uia-text";
            return "opaque";
        }

        // Does the foreground window host a Chromium renderer (Electron / a
        // Chromium browser)? Used to classify a surface as electron-msaa.
        static bool HasRendererChild()
        {
            try
            {
                IntPtr fg = GetForegroundWindow();
                if (fg == IntPtr.Zero) return false;
                bool found = false;
                EnumChildWindows(fg, (h, l) =>
                {
                    var sb = new StringBuilder(160);
                    GetClassName(h, sb, sb.Capacity);
                    if (sb.ToString() == "Chrome_RenderWidgetHostHWND") { found = true; return false; }
                    return true;
                }, IntPtr.Zero);
                return found;
            }
            catch { return false; }
        }

        static string Trunc(string s, int n) { if (s == null) return ""; return s.Length > n ? s.Substring(0, n) : s; }

        static string ProcessName(AutomationElement el)
        {
            try
            {
                int pid = el.Current.ProcessId;
                using (var proc = Process.GetProcessById(pid))
                    return proc.ProcessName;
            }
            catch { return null; }
        }

        static int RuntimeIdHash(int[] rid)
        {
            unchecked
            {
                int h = 17;
                foreach (var x in rid) h = h * 31 + x;
                return h;
            }
        }

        // --- Message-based surgical write (native Edit / RichEdit) ----------
        // For fields whose HWND is a real Edit-family control, replace ONLY
        // the changed span via EM_SETSEL + EM_REPLACESEL(fUndo=TRUE) instead
        // of ValuePattern.SetValue's whole-value clobber. No clipboard, no
        // key synthesis, no selection flash, and the app's native undo stack
        // survives. Sent with SendMessageTimeout(ABORTIFHUNG) so a wedged
        // target can never hang the shim thread. Correctness is enforced
        // empirically, not structurally: after the edit we read the value
        // back, and any mismatch (e.g. RichEdit's CR-only index model
        // skewing offsets on multiline text) is repaired on the spot by the
        // caller's SetValue fallback - so the worst case is exactly today's
        // behaviour, and the log says which control classes need index
        // mapping.
        const uint EM_SETSEL = 0x00B1;
        const uint EM_REPLACESEL = 0x00C2;
        const uint SMTO_ABORTIFHUNG = 0x0002;
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeoutMs, out IntPtr result);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "SendMessageTimeoutW")]
        static extern IntPtr SendMessageTimeoutText(IntPtr hWnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeoutMs, out IntPtr result);

        // Edit-family window classes that speak EM_* messages: classic Win32
        // "Edit", every RichEdit variant (WordPad "RICHEDIT50W", Win11
        // Notepad "RichEditD2DPT", ...), and WinForms TextBox
        // ("WindowsForms10.EDIT.app..."). WPF renders into one big
        // HwndWrapper with no per-field HWND, so it never matches and stays
        // on SetValue.
        static bool IsEditClassHwnd(IntPtr hwnd, out string className)
        {
            className = null;
            if (hwnd == IntPtr.Zero) return false;
            var sb = new StringBuilder(256);
            if (GetClassName(hwnd, sb, sb.Capacity) == 0) return false;
            className = sb.ToString();
            string c = className.ToLowerInvariant();
            return c == "edit" || c.Contains("richedit") || c.Contains(".edit.");
        }

        // Try the surgical EM path. Returns true only if the field now
        // verifiably holds `text` (read back and compared); on ANY doubt it
        // returns false and the caller falls through to SetValue.
        static bool TryEmReplaceSel(AutomationElement el, ValuePattern vp, string text)
        {
            try
            {
                string className;
                IntPtr hwnd = new IntPtr(el.Current.NativeWindowHandle);
                if (!IsEditClassHwnd(hwnd, out className)) return false;

                string oldText = vp.Current.Value ?? "";
                if (oldText == text) return true;   // nothing to write

                int p = CommonPrefixLen(oldText, text);
                int s = CommonSuffixLen(oldText, text, p);
                string fragment = text.Substring(p, text.Length - s - p);

                IntPtr res;
                // Select exactly the changed span of the OLD text...
                if (SendMessageTimeoutW(hwnd, EM_SETSEL, new IntPtr(p), new IntPtr(oldText.Length - s), SMTO_ABORTIFHUNG, 2000, out res) == IntPtr.Zero)
                    return false;
                // ...and replace it, undoably, with the changed span of the NEW.
                if (SendMessageTimeoutText(hwnd, EM_REPLACESEL, new IntPtr(1) /* fUndo */, fragment, SMTO_ABORTIFHUNG, 2000, out res) == IntPtr.Zero)
                    return false;
                // Phase-1 cursor model assumes end-of-text; EM_REPLACESEL left
                // the caret after the fragment, which is already the end when
                // the kept suffix is empty. Restore end otherwise.
                if (s > 0)
                    SendMessageTimeoutW(hwnd, EM_SETSEL, new IntPtr(text.Length), new IntPtr(text.Length), SMTO_ABORTIFHUNG, 2000, out res);

                // Verify. A mismatch means this control's EM index model
                // doesn't match the UIA string (CRLF skew etc.) - report the
                // class so the sweep catalogs it, and let SetValue repair.
                string after = null;
                try { after = vp.Current.Value ?? ""; } catch { }
                if (after != text)
                {
                    Log("warn", "EM_REPLACESEL verify mismatch on class '" + className + "' (old=" + oldText.Length + " new=" + text.Length + " p=" + p + " s=" + s + ") - repairing via SetValue");
                    return false;
                }
                Log("debug", "applied substitution (" + text.Length + " chars, EM_REPLACESEL span " + p + ".." + (oldText.Length - s) + " -> +" + fragment.Length + ", class " + className + ")");
                return true;
            }
            catch (Exception ex)
            {
                Log("debug", "EM_REPLACESEL path unavailable: " + ex.Message);
                return false;
            }
        }

        // --- Simulated-input write (Electron / Chromium / contenteditable) --
        // For editors with no writable ValuePattern (VS Code, Discord, Slack,
        // web text boxes), replace the field via the app's OWN paste path:
        // set the clipboard, Ctrl+A (select all), Ctrl+V (paste), then
        // restore the clipboard. Same approach espanso / AutoHotkey / the
        // Grammarly desktop app use. Win32 clipboard API (not the .NET
        // Clipboard class) so it works from this MTA thread.
        const uint CF_UNICODETEXT = 13;
        const uint GMEM_MOVEABLE = 0x0002;
        [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr hWndNewOwner);
        [DllImport("user32.dll")] static extern bool CloseClipboard();
        [DllImport("user32.dll")] static extern bool EmptyClipboard();
        [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint uFormat);
        [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
        [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);
        [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
        [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr hMem);
        [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr hMem);

        static string GetClipboardText()
        {
            if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return null;
            if (!OpenClipboard(IntPtr.Zero)) return null;
            try
            {
                IntPtr h = GetClipboardData(CF_UNICODETEXT);
                if (h == IntPtr.Zero) return null;
                IntPtr p = GlobalLock(h);
                if (p == IntPtr.Zero) return null;
                try { return Marshal.PtrToStringUni(p); }
                finally { GlobalUnlock(h); }
            }
            finally { CloseClipboard(); }
        }

        static void SetClipboardText(string text)
        {
            if (text == null) text = "";
            if (!OpenClipboard(IntPtr.Zero)) return;
            try
            {
                EmptyClipboard();
                byte[] bytes = Encoding.Unicode.GetBytes(text + "\0");
                IntPtr hGlobal = GlobalAlloc(GMEM_MOVEABLE, new UIntPtr((uint)bytes.Length));
                if (hGlobal == IntPtr.Zero) return;
                IntPtr p = GlobalLock(hGlobal);
                if (p == IntPtr.Zero) return;
                Marshal.Copy(bytes, 0, p, bytes.Length);
                GlobalUnlock(hGlobal);
                SetClipboardData(CF_UNICODETEXT, hGlobal);   // clipboard owns hGlobal now
            }
            finally { CloseClipboard(); }
        }

        [StructLayout(LayoutKind.Sequential)]
        struct INPUT { public uint type; public InputUnion U; }
        // The union MUST be sized to its LARGEST variant (MOUSEINPUT). With
        // only KEYBDINPUT, sizeof(INPUT) is 32 on x64 instead of the ABI's 40,
        // and SendInput rejects every call with ERROR_INVALID_PARAMETER (87),
        // sending nothing - so Ctrl+A/Ctrl+V never reach the app and the paste
        // silently no-ops. (Verified: KEYBDINPUT-only -> sent=0; +MOUSEINPUT ->
        // sent=n.) MOUSEINPUT (28 bytes -> 32 padded) pads the union to match.
        [StructLayout(LayoutKind.Explicit)]
        struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
        const uint INPUT_KEYBOARD = 1;
        const uint KEYEVENTF_KEYUP = 0x0002;
        const ushort VK_CONTROL = 0x11;
        const ushort VK_A = 0x41;
        const ushort VK_V = 0x56;
        const ushort VK_BACK = 0x08;
        const ushort VK_LEFT = 0x25;

        static INPUT KeyInput(ushort vk, bool up)
        {
            return new INPUT
            {
                type = INPUT_KEYBOARD,
                U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = up ? KEYEVENTF_KEYUP : 0, time = 0, dwExtraInfo = IntPtr.Zero } },
            };
        }

        static void KeyChord(ushort modifier, ushort key)
        {
            var inputs = new INPUT[]
            {
                KeyInput(modifier, false),
                KeyInput(key, false),
                KeyInput(key, true),
                KeyInput(modifier, true),
            };
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        // Select-all COMMIT gap (ms) for the big-field path. Default 0 -> 15ms.
        // Tunable via OPENCUES_PASTE_GAP_MS without a rebuild.
        static readonly int _pasteGapMs = ReadPasteGapMs();
        static int ReadPasteGapMs()
        {
            var v = Environment.GetEnvironmentVariable("OPENCUES_PASTE_GAP_MS");
            int g;
            if (!string.IsNullOrEmpty(v) && int.TryParse(v, out g) && g >= 0 && g <= 300) return g;
            return 0;
        }

        // Replace the field via a PREFIX + SUFFIX DIFF instead of clearing the
        // whole field. Trim the unchanged common HEAD and TAIL of old vs new;
        // what's left is the minimal EDIT WINDOW. From the caret at end:
        // Left x suffix (walk over the kept tail), Backspace x window (delete
        // the old window), Ctrl+V (paste only the new window) - one atomic
        // SendInput burst, no selection, no flash. Tail-localized edits keep
        // the old behaviour exactly (suffix = 0 -> no Lefts); mid-buffer
        // rewrites (transform-blank on an inner sentence) now take the smooth
        // path too instead of falling back to Ctrl+A.
        // _backspaceMax bounds the EDIT WINDOW (default 160, was 40 when the
        // window was prefix-only; env OPENCUES_BACKSPACE_MAX overrides without
        // a rebuild); LEFT_MAX bounds the caret walk. Only a genuine
        // whole-field rewrite falls back to Ctrl+A + full paste (one highlight
        // frame). No margin on either count: the kept head and tail must be
        // preserved exactly.
        // After a mid-buffer edit the caret is left AFTER the pasted window
        // (not restored to end): Electron commits Ctrl+V asynchronously, so a
        // caret-restore chord in the same burst can land BEFORE the paste and
        // redirect it to the wrong spot. Deliberate v1 tradeoff.
        // `oldText` is the field's current content the shim last read.
        const int LEFT_MAX = 400;
        static readonly int _backspaceMax = ReadBackspaceMax();
        static int ReadBackspaceMax()
        {
            var v = Environment.GetEnvironmentVariable("OPENCUES_BACKSPACE_MAX");
            int g;
            if (!string.IsNullOrEmpty(v) && int.TryParse(v, out g) && g >= 0 && g <= 4000) return g;
            return 160;
        }

        static void PasteReplace(string text, string oldText)
        {
            int oldLen = oldText != null ? oldText.Length : 0;
            int p = CommonPrefixLen(oldText, text);          // unchanged head we keep
            int s = CommonSuffixLen(oldText, text, p);       // unchanged tail we keep
            int changed = oldLen - p - s;                    // old chars inside the edit window
            string fragment = text.Substring(p, text.Length - s - p);   // new window content

            // One Left per kept-suffix char is only sound when one string char
            // is one caret position. '\n' is a single position in Chromium
            // fields; a '\r' means CRLF-normalized text whose offsets skew, so
            // fall back to the whole-field path rather than walk blind.
            bool caretWalkable = s == 0
                || (s <= LEFT_MAX && oldText.IndexOf('\r', oldLen - s) < 0);

            Log("debug", "diff-paste: prefix=" + p + " suffix=" + s + " window=" + changed + "/" + oldLen
                + " frag=" + fragment.Length + " newLen=" + text.Length
                + (changed <= _backspaceMax && caretWalkable ? " -> windowed (no flash)" : " -> Ctrl+A (flash)"));

            string saved = null;
            if (changed <= _backspaceMax && caretWalkable)
            {
                // Targeted window edit. Pure deletions (empty fragment) need
                // no clipboard at all - just the caret walk + backspaces.
                if (fragment.Length > 0)
                {
                    try { saved = GetClipboardText(); } catch { }
                    SetClipboardText(fragment);
                    Thread.Sleep(15);
                }
                BurstEdit(s, changed, fragment.Length > 0);
            }
            else
            {
                // Whole-field rewrite (no small window to exploit): select-all
                // + paste the full text. The commit gap lets the selection land
                // before the paste (else it APPENDS). One highlight frame.
                try { saved = GetClipboardText(); } catch { }
                SetClipboardText(text);
                Thread.Sleep(15);
                int commitMs = _pasteGapMs > 0 ? _pasteGapMs : 15;
                KeyChord(VK_CONTROL, VK_A);
                Thread.Sleep(commitMs);
                KeyChord(VK_CONTROL, VK_V);
            }
            if (saved != null)
            {
                // Electron reads the clipboard ASYNCHRONOUSLY after Ctrl+V;
                // 300ms clears that read before we restore the user's previous
                // clipboard.
                Thread.Sleep(300);
                try { SetClipboardText(saved); } catch { }
            }
        }

        // Length of the longest common prefix of a and b (the unchanged head).
        static int CommonPrefixLen(string a, string b)
        {
            if (a == null || b == null) return 0;
            int n = Math.Min(a.Length, b.Length);
            int i = 0;
            while (i < n && a[i] == b[i]) i++;
            return i;
        }

        // Length of the longest common suffix of a and b that does NOT overlap
        // the already-claimed prefix (so prefix + suffix never double-count a
        // char - old "aaa" vs new "aa" is prefix 2, suffix 0, window "a").
        static int CommonSuffixLen(string a, string b, int prefix)
        {
            if (a == null || b == null) return 0;
            int n = Math.Min(a.Length, b.Length) - prefix;
            int i = 0;
            while (i < n && a[a.Length - 1 - i] == b[b.Length - 1 - i]) i++;
            return i;
        }

        // lefts x Left, then backspaces x Backspace, then (optionally) Ctrl+V,
        // all in one atomic SendInput burst. The editor processes the caret
        // walk, the deletes, and the paste back-to-back off its input queue
        // with no frame rendered between - no highlight, no empty-placeholder
        // flash. Backspace deletes are sequential model edits (unlike Ctrl+A,
        // which needs a selection COMMIT the paste can outrun), so the paste
        // reliably lands in the emptied window.
        static void BurstEdit(int lefts, int backspaces, bool paste)
        {
            if (lefts < 0) lefts = 0;
            if (lefts > LEFT_MAX) lefts = LEFT_MAX;
            if (backspaces < 0) backspaces = 0;
            if (backspaces > 4000) backspaces = 4000;
            var inputs = new INPUT[lefts * 2 + backspaces * 2 + (paste ? 4 : 0)];
            int k = 0;
            for (int i = 0; i < lefts; i++)
            {
                inputs[k++] = KeyInput(VK_LEFT, false);
                inputs[k++] = KeyInput(VK_LEFT, true);
            }
            for (int i = 0; i < backspaces; i++)
            {
                inputs[k++] = KeyInput(VK_BACK, false);
                inputs[k++] = KeyInput(VK_BACK, true);
            }
            if (paste)
            {
                inputs[k++] = KeyInput(VK_CONTROL, false);
                inputs[k++] = KeyInput(VK_V, false);
                inputs[k++] = KeyInput(VK_V, true);
                inputs[k++] = KeyInput(VK_CONTROL, true);
            }
            if (inputs.Length > 0)
                SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        // --- Socket send ------------------------------------------------
        static void SendRaw(string json)
        {
            var s = _stream;
            if (s == null) return;
            var bytes = Encoding.UTF8.GetBytes(json + "\n");
            lock (_sendLock)
            {
                try { s.Write(bytes, 0, bytes.Length); s.Flush(); }
                catch (Exception ex) { Console.WriteLine("send failed: " + ex.Message); Disconnect(); }
            }
        }

        // Log locally AND forward to the daemon (as a `log` message) so the
        // Windows-side UIA half lands in the SAME /tmp/opencues.log -
        // tagged [windows][shim] - even when the tray launched us hidden.
        // Pre-connect lines only reach the console (no socket yet); that's
        // fine - the daemon's absent "shim connected" already flags that.
        static void Log(string level, string msg)
        {
            Console.WriteLine(msg);
            if (_stream == null) return;
            try { SendRaw("{\"t\":\"log\",\"level\":" + JStr(level) + ",\"msg\":" + JStr(msg) + "}"); }
            catch { /* logging must never break the shim */ }
        }

        // --- Tiny helpers -----------------------------------------------
        static string Str(Dictionary<string, object> m, string k)
        {
            object v; return (m != null && m.TryGetValue(k, out v) && v != null) ? v.ToString() : null;
        }

        // JSON-encode a string (with surrounding quotes). Null -> "".
        static string JStr(string s)
        {
            if (s == null) return "\"\"";
            var sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }

    // --- Minimal JSON parser (objects/arrays/strings/numbers/bool/null) --
    // Enough to decode the daemon's line-oriented commands without pulling
    // in Newtonsoft (absent on a stock Windows PowerShell) or
    // System.Text.Json (absent on .NET Framework).
    internal static class MiniJson
    {
        public static object Parse(string json)
        {
            int i = 0;
            var v = ParseValue(json, ref i);
            return v;
        }

        static object ParseValue(string s, ref int i)
        {
            SkipWs(s, ref i);
            char c = s[i];
            if (c == '{') return ParseObject(s, ref i);
            if (c == '[') return ParseArray(s, ref i);
            if (c == '"') return ParseString(s, ref i);
            if (c == 't' || c == 'f') return ParseBool(s, ref i);
            if (c == 'n') { i += 4; return null; }
            return ParseNumber(s, ref i);
        }

        static Dictionary<string, object> ParseObject(string s, ref int i)
        {
            var d = new Dictionary<string, object>();
            i++; // {
            SkipWs(s, ref i);
            if (s[i] == '}') { i++; return d; }
            while (true)
            {
                SkipWs(s, ref i);
                string key = ParseString(s, ref i);
                SkipWs(s, ref i);
                i++; // :
                object val = ParseValue(s, ref i);
                d[key] = val;
                SkipWs(s, ref i);
                char c = s[i++];
                if (c == '}') break;
                // c == ','
            }
            return d;
        }

        static List<object> ParseArray(string s, ref int i)
        {
            var a = new List<object>();
            i++; // [
            SkipWs(s, ref i);
            if (s[i] == ']') { i++; return a; }
            while (true)
            {
                a.Add(ParseValue(s, ref i));
                SkipWs(s, ref i);
                char c = s[i++];
                if (c == ']') break;
            }
            return a;
        }

        static string ParseString(string s, ref int i)
        {
            var sb = new StringBuilder();
            i++; // opening quote
            while (true)
            {
                char c = s[i++];
                if (c == '"') break;
                if (c == '\\')
                {
                    char e = s[i++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'u':
                            string hex = s.Substring(i, 4); i += 4;
                            sb.Append((char)int.Parse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            break;
                        default: sb.Append(e); break;
                    }
                }
                else sb.Append(c);
            }
            return sb.ToString();
        }

        static object ParseBool(string s, ref int i)
        {
            if (s[i] == 't') { i += 4; return true; }
            i += 5; return false;
        }

        static object ParseNumber(string s, ref int i)
        {
            int start = i;
            while (i < s.Length && "-+.eE0123456789".IndexOf(s[i]) >= 0) i++;
            string num = s.Substring(start, i - start);
            double d;
            double.TryParse(num, NumberStyles.Any, CultureInfo.InvariantCulture, out d);
            return d;
        }

        static void SkipWs(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
        }
    }
}
