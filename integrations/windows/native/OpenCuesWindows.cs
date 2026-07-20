// OpenCues Windows shim - the thin native half of the Windows
// integration. Runs on Windows; does NOT contain any OpenCues logic.
// Its whole job:
//
//   1. Watch the currently-focused text field via UI Automation.
//   2. Stream its text (+ focus/blur) to the WSL-side daemon over a
//      TCP socket (127.0.0.1:<port>, forwarded into WSL by WSL2).
//   3. Apply `set-text` commands the daemon sends back (LLM
//      substitutions, blank fills) via UIA ValuePattern.SetValue.
//
// Phase 2 (this build) adds, on top of the phase-1 read/write core:
//   * a WH_KEYBOARD_LL hook that intercepts Ctrl+Alt+arrows while a
//     cycling-capable field is attached and forwards them to the daemon
//     (swallowed; re-injected with an extra-info mark if the runtime
//     did not consume them),
//   * a layered click-through overlay (OverlayForm) that paints the
//     runtime's dim/highlight char ranges as screen rects resolved via
//     UIA TextPattern GetBoundingRectangles - three switchable looks:
//     underline / wash / capture (style rides the `render` message,
//     picked by the daemon's OPENCUES_WIN_OVERLAY_STYLE env),
//   * real caret tracking via native IUIAutomationTextPattern2
//     GetCaretRange (falls back to the phase-1 caret-at-end model).
// Per-field: only UIA-attached fields with a managed TextPattern get
// the phase-2 treatment ("cycling": true on the focus message); MSAA/
// Electron fields keep the phase-1 no-cycling profile. Kill switches:
// OPENCUES_WIN_HOOK=0 (no chord hook), OPENCUES_WIN_OVERLAY=0 (no
// overlay paint), and daemon-side OPENCUES_WIN_PHASE2=0 (whole profile).
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
using System.Windows.Automation.Text;   // TextPatternRange - caret restore on Chromium-UIA fields
using Accessibility;   // MSAA/IA2 IAccessible - the Chromium/Electron read path
// Aliased (not opened) to avoid name collisions with the UIA namespaces;
// only the phase-2 overlay uses them.
using SWF = System.Windows.Forms;
using SD = System.Drawing;

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
        static string _lastApp = null;        // process name of the attached field's app
        static volatile bool _attached = false;
        // Phase 2: the attached field can host the overlay + chord hook
        // (UIA attach with a managed TextPattern). Written on the poll
        // thread, read by the keyboard-hook thread - volatile.
        static volatile bool _fieldCycling = false;

        // Ring of recent self-writes (value + tick). The loading animation
        // writes a frame every ~50ms but the poll reads every ~150ms, so a
        // read-back is routinely a STALE frame - it matches an OLDER write,
        // not the single latest _expectedEcho. Treating those as user typing
        // made the daemon re-resolve mid-animation (spinner <-> final-text
        // oscillation, "live text changed" skips with no human at the
        // keyboard). A read-back matching ANY entry younger than the TTL is
        // our own echo. All touched from the poll thread only - no lock.
        // (Same self-write-TTL pattern as kata's 250ms trace guard.)
        static readonly List<KeyValuePair<string, int>> _recentWrites = new List<KeyValuePair<string, int>>();
        const int RECENT_WRITE_TTL_MS = 3000;
        const int RECENT_WRITE_CAP = 32;

        // Ring keys are EOL-normalized: controls echo our writes with their
        // own line separators (RichEdit reads back "\r" for a written "\n"),
        // and that must still count as our echo, not user typing.
        static string EolNorm(string s)
        {
            if (s == null) return s;
            // Fold every line-break dress to LF: CRLF/CR (RichEdit paragraph +
            // echo), VT (RichEdit soft break we WRITE), and U+2028 (some RichEdit
            // read-backs). Keeps write-verify + self-write attribution EOL-blind.
            if (s.IndexOf('\r') < 0 && s.IndexOf('\v') < 0 && s.IndexOf('\u2028') < 0) return s;
            return s.Replace("\r\n", "\n").Replace('\r', '\n').Replace('\v', '\n').Replace('\u2028', '\n');
        }

        // Write bracket - knowledge-based attribution. Every write enters the
        // field through NoteSelfWrite, so the shim KNOWS when a write stream
        // is in flight; it doesn't have to infer it from read-backs. While the
        // bracket is open (refreshed per write, closed after WRITE_QUIET_MS of
        // silence) read-backs are unattributable and are NOT reported to the
        // daemon. When the stream goes quiet, ONE reconciliation read decides:
        // field holds our latest write (in any EOL dress) -> silent sync;
        // field holds a stale self-write (async editor still settling, e.g.
        // Slack's Quill) -> wait another quiet window; anything else -> a
        // genuine divergence (user typed / app transformed the text), report
        // it. BRACKET_MAX_MS hard-caps the whole dance so a pathological app
        // can never starve user-typing reports. This is what makes an
        // animation (a frame every ~50ms against a ~150ms poll) safe on a
        // host that doesn't own the buffer - the other hosts get write/type
        // attribution for free by living inside the editor process.
        static bool _bracketOpen = false;
        static int _bracketQuietAt = 0;    // tick when the bracket may close
        static int _bracketOpenedAt = 0;   // tick when it opened (for the cap)
        static string _bracketBaseline = null;   // field state when the bracket opened
        const int WRITE_QUIET_MS = 350;
        const int BRACKET_MAX_MS = 5000;

        static void NoteSelfWrite(string text)
        {
            int now = Environment.TickCount;
            if (!_bracketOpen) { _bracketOpen = true; _bracketOpenedAt = now; _bracketBaseline = _lastSentText; }
            _bracketQuietAt = now + WRITE_QUIET_MS;
            _expectedEcho = text;
            _lastSentText = text;
            _recentWrites.Add(new KeyValuePair<string, int>(EolNorm(text), Environment.TickCount));
            if (_recentWrites.Count > RECENT_WRITE_CAP) _recentWrites.RemoveAt(0);
        }

        static bool IsRecentSelfWrite(string cur)
        {
            int now = Environment.TickCount;
            string norm = EolNorm(cur);
            for (int i = _recentWrites.Count - 1; i >= 0; i--)
            {
                if (unchecked(now - _recentWrites[i].Value) > RECENT_WRITE_TTL_MS) { _recentWrites.RemoveRange(0, i + 1); return false; }
                if (_recentWrites[i].Key == norm) return true;
            }
            return false;
        }

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

        // Wakes the poll loop ahead of its tick. Set by: the socket reader
        // (inbound set-text frames apply at the runtime's real animation
        // frame rate instead of tick granularity), the global focus-changed
        // wake handler, and the per-element UIA change events below. The
        // poll interval remains the fallback cadence when no events fire.
        static readonly AutoResetEvent _wake = new AutoResetEvent(false);

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
            EnsureDpiAware();   // overlay rects are physical px; must run before any window exists
            StartKeyHook();
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
            try { StopKeyHook(); } catch { }
            try { StopOverlay(); } catch { }
            try { UnhookElementEvents(); } catch { }
            try { if (_wakeHandler != null) { Automation.RemoveAutomationFocusChangedEventHandler(_wakeHandler); _wakeHandler = null; } } catch { }
            try { _wake.Set(); } catch { }   // release a loop parked in WaitOne
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
                _wakeHandler = (s, e) => { try { _wake.Set(); } catch { } };
                Automation.AddAutomationFocusChangedEventHandler(_wakeHandler);
            }
            catch { _wakeHandler = null; }
        }

        // Per-element change events - the input-latency fast path. On a UIA
        // attach, subscribe to ValueChanged + TextChanged on the focused
        // element; each event just wakes the poll loop, so a keystroke is
        // read within milliseconds instead of up to a full tick. State stays
        // poll-thread-only (handlers run on UIA callback threads and touch
        // nothing but the wake handle). Our own SetValue writes also fire
        // these - harmless: the woken tick's read is swallowed by the write
        // bracket. MSAA-attached Electron fields get no reliable UIA events;
        // they stay on the tick fallback.
        static AutomationElement _hookedEl = null;
        static int _hookedElId = int.MinValue;
        static AutomationPropertyChangedEventHandler _valueChangedHandler;
        static AutomationEventHandler _textChangedHandler;

        static void HookElementEvents(AutomationElement el, int elId)
        {
            if (elId == _hookedElId) return;
            UnhookElementEvents();
            try
            {
                // Change events also mark the overlay dirty: a typing-induced
                // reflow re-rects on the SAME wake (anti-flash step 2).
                _valueChangedHandler = (s, e) => { try { _overlayDirty = true; _wake.Set(); } catch { } };
                Automation.AddAutomationPropertyChangedEventHandler(el, TreeScope.Element, _valueChangedHandler, ValuePattern.ValueProperty);
            }
            catch { _valueChangedHandler = null; }
            try
            {
                _textChangedHandler = (s, e) => { try { _overlayDirty = true; _wake.Set(); } catch { } };
                Automation.AddAutomationEventHandler(TextPattern.TextChangedEvent, el, TreeScope.Element, _textChangedHandler);
            }
            catch { _textChangedHandler = null; }
            _hookedEl = el;
            _hookedElId = elId;
            Log("debug", "change events hooked (value=" + (_valueChangedHandler != null) + " text=" + (_textChangedHandler != null) + ")");
        }

        static void UnhookElementEvents()
        {
            if (_hookedEl == null) { _hookedElId = int.MinValue; return; }
            try { if (_valueChangedHandler != null) Automation.RemoveAutomationPropertyChangedEventHandler(_hookedEl, _valueChangedHandler); } catch { }
            try { if (_textChangedHandler != null) Automation.RemoveAutomationEventHandler(TextPattern.TextChangedEvent, _hookedEl, _textChangedHandler); } catch { }
            _valueChangedHandler = null;
            _textChangedHandler = null;
            _hookedEl = null;
            _hookedElId = int.MinValue;
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
                    MaybeReassertCaret();    // win Chromium's async caret-reset race after UIA writes
                    if (_enabled)
                    {
                        PollFocus();
                        MaybePollCaret();      // phase 2: real caret -> daemon cursor events
                        MaybeRefreshOverlay(); // phase 2: track window moves/scrolls
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
                // Event-driven fast path: UIA change events (and daemon
                // commands) Set() the wake handle, so a keystroke is read
                // within milliseconds instead of waiting out the tick. The
                // timeout keeps the classic poll as the fallback for apps
                // whose UIA event providers are broken or absent (MSAA-
                // attached Electron fields have no reliable UIA events).
                _wake.WaitOne(_pollMs);
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
                _recentWrites.Clear();
                _bracketOpen = false;
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
                    if (line.Length > 0) { _incoming.Enqueue(line); _wake.Set(); }
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
                        // Phase 2: position the caret (EM_SETSEL on Edit-family
                        // HWNDs, native-UIA collapsed Select elsewhere).
                        ApplySetCursor(Num(map, "cursor", -1));
                        break;
                    case "render":
                        // Phase 2: dim/highlight char spans for the overlay.
                        HandleRenderMsg(map);
                        break;
                    case "key-result":
                        // Phase 2: the runtime's verdict on a chord we swallowed.
                        HandleKeyResult(map);
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
                // Phase 2 capability probe: a managed TextPattern is what the
                // overlay needs for GetBoundingRectangles, so it decides the
                // per-field cycling answer (Chromium-UIA composers like Slack
                // expose TextPattern only to a NATIVE client -> stay phase 1).
                bool cycling = HasManagedTextPattern(el);
                StreamAttachment(elId, app, ReadValue(el), AttachMode.Uia, cycling);
                HookElementEvents(el, elId);
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
                    StreamAttachment(mnode, app, mtext, AttachMode.Msaa, false);
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
        static void StreamAttachment(int elId, string app, string readText, AttachMode mode, bool cycling)
        {
            _lastApp = app;
            if (elId != _lastElementId)
            {
                _lastElementId = elId;
                _attachMode = mode;
                _fieldCycling = cycling;
                _lastSentText = readText;
                _lastSentCaret = -1;
                _expectedEcho = null;
                _recentWrites.Clear();
                _bracketOpen = false;
                _attached = true;
                StatusLine = "on: " + (app ?? "text field");
                Log("info", "attached: " + (app ?? "text field") + " ("
                    + (readText == null ? 0 : readText.Length) + " chars, "
                    + (mode == AttachMode.Msaa ? "MSAA" : "UIA")
                    + (cycling ? ", cycling" : "") + ")");
                SendRaw("{\"t\":\"focus\",\"app\":" + JStr(app) + ",\"text\":" + JStr(readText)
                    + ",\"cursor\":" + CaretOrEnd(readText).ToString(CultureInfo.InvariantCulture)
                    + ",\"cycling\":" + (cycling ? "true" : "false")
                    + ",\"fieldId\":" + elId.ToString(CultureInfo.InvariantCulture) + "}");
                return;
            }

            // Same element - send text only when it changed and it isn't our
            // own write echoing back.
            _attachMode = mode;
            string cur = readText;
            if (cur == null) return;

            // Write bracket open: reads are unattributable while our writes
            // are in flight - report nothing until the stream is quiet, then
            // reconcile once (see NoteSelfWrite).
            if (_bracketOpen)
            {
                int now = Environment.TickCount;
                bool quiet = unchecked(now - _bracketQuietAt) >= 0;
                bool capped = unchecked(now - _bracketOpenedAt) > BRACKET_MAX_MS;
                if (!quiet && !capped) return;
                if (!capped && EolNorm(cur) != EolNorm(_lastSentText) && IsRecentSelfWrite(cur))
                {
                    // Async editor still settling on a stale frame - hold the
                    // bracket for another quiet window.
                    _bracketQuietAt = now + WRITE_QUIET_MS;
                    Log("debug", "bracket: field settling on stale frame (" + cur.Length + " chars), holding");
                    return;
                }
                _bracketOpen = false;
                Log("debug", "bracket: closed after " + unchecked(now - _bracketOpenedAt) + "ms, reconciling");
                // Android R6 lesson (managed editors REVERT external writes,
                // e.g. Lexical): a reconcile that lands back on the PRE-WRITE
                // content means this app rejected our writes - name it loudly
                // so the sweep catalogs the app; the divergence report below
                // then re-syncs the daemon so the runtime knows the
                // substitution didn't stick. Escalation (retry via the paste
                // path) is deferred until a real app exhibits this.
                if (_bracketBaseline != null && EolNorm(cur) == EolNorm(_bracketBaseline)
                    && EolNorm(cur) != EolNorm(_lastSentText))
                    Log("warn", "app '" + (_lastApp ?? "?") + "' REVERTED our write(s) - field returned to pre-write content (" + cur.Length + " chars)");
                _bracketBaseline = null;
                // fall through: the normal checks below decide whether `cur`
                // is our write (silent sync) or a genuine divergence (report).
            }

            if (_expectedEcho != null && cur == _expectedEcho) { _lastSentText = cur; return; }
            if (cur == _lastSentText) return;
            if (IsRecentSelfWrite(cur))
            {
                // Our own write in the control's EOL dress (RichEdit echoes
                // "\r" for a written "\n") or a late stale echo. Adopt the
                // field's representation so subsequent polls compare equal.
                _lastSentText = cur;
                Log("debug", "adopted self-write echo (" + cur.Length + " chars)");
                return;
            }
            _lastSentText = cur;
            _expectedEcho = null;
            SendRaw("{\"t\":\"text\",\"text\":" + JStr(cur)
                + ",\"cursor\":" + CaretOrEnd(cur).ToString(CultureInfo.InvariantCulture) + "}");
        }

        static void LeaveAttached(string app)
        {
            if (!_attached) { _lastElementId = int.MinValue; if (_enabled) StatusLine = "idle"; return; }
            _attached = false;
            _fieldCycling = false;
            _lastSentCaret = -1;
            ClearOverlaySpans();
            _lastElementId = int.MinValue;
            _lastSentText = null;
            _expectedEcho = null;
            _recentWrites.Clear();
            _bracketOpen = false;
            _lastApp = null;
            UnhookElementEvents();
            _attachMode = AttachMode.None;
            _pendingMsaaText = null;
            if (_enabled) StatusLine = "idle";
            Log("debug", "detached" + (app != null ? " (now on " + app + ", not attachable)" : ""));
            SendRaw("{\"t\":\"blur\",\"app\":" + JStr(app) + "}");
        }

        // --- UIA read/write ---------------------------------------------

        // WordPad's RICHEDIT50W (via the MSAA->UIA proxy) includes RichEdit's
        // phantom FINAL PARAGRAPH MARK in the ValuePattern value. Left alone
        // it leaks into the daemon's mirror as if the user typed a trailing
        // newline, round-trips through every write, and pushes "end of text"
        // onto an empty next line (caret visibly jumped lines after
        // substitutions). Strip exactly ONE trailing separator at the READ
        // boundary so it never enters the pipeline. Scoped to richedit50w
        // only: Notepad's RichEditD2DPT provider does NOT include the
        // phantom, so a blanket strip would eat a genuine trailing newline
        // there.
        static string StripPhantomTrailingSeparator(AutomationElement el, string value)
        {
            if (string.IsNullOrEmpty(value)) return value;
            char last = value[value.Length - 1];
            if (last != '\r' && last != '\n') return value;
            try
            {
                IntPtr hwnd = new IntPtr(el.Current.NativeWindowHandle);
                if (hwnd == IntPtr.Zero) return value;
                var sb = new StringBuilder(256);
                if (GetClassName(hwnd, sb, sb.Capacity) == 0) return value;
                if (!sb.ToString().ToLowerInvariant().Contains("richedit50w")) return value;
            }
            catch { return value; }
            if (value.EndsWith("\r\n")) return value.Substring(0, value.Length - 2);
            return value.Substring(0, value.Length - 1);
        }

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
                    return StripPhantomTrailingSeparator(el, ((ValuePattern)vp).Current.Value ?? "");
            }
            catch { }
            try
            {
                object tp;
                if (el.TryGetCurrentPattern(TextPattern.Pattern, out tp))
                    return StripPhantomTrailingSeparator(el, ((TextPattern)tp).DocumentRange.GetText(-1) ?? "");
            }
            catch { }
            // Last resort: a read-only ValuePattern value (better than nothing).
            try
            {
                object vp2;
                if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vp2))
                    return StripPhantomTrailingSeparator(el, ((ValuePattern)vp2).Current.Value ?? "");
            }
            catch { }
            return null;
        }

        // Apps whose composer renders EVERY newline as a paragraph block with
        // vertical margin (Slack's Quill editor), so a blank line ("\n\n")
        // displays as a double-height gap while Notepad/Discord show the same
        // characters compactly. For those apps, collapse blank-line runs to
        // single newlines before writing. Content-only, best-effort visual
        // parity: the daemon's mirror re-syncs on the next keystroke's text
        // event (same transient divergence class as RichEdit's \r read-back).
        // Override with OPENCUES_PARA_APPS (comma-separated process names;
        // set empty to disable) - no rebuild needed.
        static readonly HashSet<string> ParagraphBreakApps = ReadParaApps();
        static HashSet<string> ReadParaApps()
        {
            var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var v = Environment.GetEnvironmentVariable("OPENCUES_PARA_APPS");
            if (v == null) { set.Add("slack"); set.Add("wordpad"); return set; }
            foreach (var part in v.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var t = part.Trim();
                if (t.Length > 0) set.Add(t);
            }
            return set;
        }

        // WordPad (RichEdit) renders newlines via the EM write path as SOFT
        // breaks (VT - no paragraph margin), so a single \n comes out adjacent
        // and \n\n comes out as a blank line, EXACTLY like Notepad. It must
        // therefore KEEP its blank lines, so it's excluded from the collapse
        // below (collapsing \n\n would erase the paragraph separation). Slack's
        // Quill has no soft break, so it still gets the collapse.
        static readonly HashSet<string> RichEditParagraphApps =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "wordpad" };

        // Chromium/Quill composers whose ValuePattern.SetValue turns every \n
        // into a paragraph block (blank-line gap even for single \n). Their PASTE
        // handler treats \n as a soft break, so we route the final write through
        // paste for these to render newlines like Notepad. Override with
        // OPENCUES_PASTE_APPS (comma-separated process names; empty to disable).
        static readonly HashSet<string> PastePreferredApps = ReadPasteApps();
        static HashSet<string> ReadPasteApps()
        {
            var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var v = Environment.GetEnvironmentVariable("OPENCUES_PASTE_APPS");
            if (v == null) { set.Add("slack"); return set; }
            foreach (var part in v.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var t = part.Trim();
                if (t.Length > 0) set.Add(t);
            }
            return set;
        }

        static string NormalizeNewlinesForApp(string text)
        {
            // Paragraph-apps (Slack, WordPad) now PRESERVE blank lines so they
            // render like Notepad (\n = adjacent line, \n\n = blank line).
            // WordPad soft-breaks each \n via the EM path (VT, no paragraph
            // margin); Slack takes the raw text via SetValue. We only fold
            // CRLF -> LF here and NEVER collapse \n\n (that was flattening the
            // paragraph separation). Kept behind the app gate so it never
            // touches Notepad/Discord/etc.
            if (text == null || _lastApp == null || !ParagraphBreakApps.Contains(_lastApp)) return text;
            if (text.IndexOf('\r') < 0) return text;
            return text.Replace("\r\n", "\n").Replace('\r', '\n');
        }

        // A set-text may arrive AFTER focus moved (an in-flight LLM result
        // outliving the field it was resolved for). Writing it into
        // AutomationElement.FocusedElement would land it in whatever the
        // user focused next - a wrong-field write, the worst failure class
        // this host has. Verify the focused element IS the attached one
        // (UIA runtime-id match) before any write path runs; MSAA mode has
        // no comparable id, so it gates on _attached alone (its writes are
        // also deferred + flushed only while the stream is quiet).
        static bool FocusedElementIsAttached()
        {
            if (!_attached) return false;
            try
            {
                AutomationElement el = AutomationElement.FocusedElement;
                if (el == null) return false;
                int id = el.GetRuntimeId() != null ? RuntimeIdHash(el.GetRuntimeId()) : el.GetHashCode();
                return id == _lastElementId;
            }
            catch { return false; }
        }

        static void ApplySetText(string text)
        {
            if (text == null) return;
            if (_attachMode == AttachMode.Uia && !FocusedElementIsAttached())
            {
                Log("warn", "set-text dropped - focused field is not the attached field (late in-flight result)");
                return;
            }
            if (_attachMode == AttachMode.Msaa && !_attached)
            {
                Log("warn", "set-text dropped - no attached field (late in-flight result)");
                return;
            }
            text = NormalizeNewlinesForApp(text);

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
                // Live micro-frames: a tiny TAIL edit vs the field's current
                // content (the BlankLoading spinner churning one char near
                // the trailing `_`) is applied IMMEDIATELY as synthetic
                // typing - Backspace x del + KEYEVENTF_UNICODE chars in one
                // atomic burst. No clipboard, no select-all flash, none of
                // Electron's async-clipboard timing - so Electron apps show
                // the loading animation live instead of one coalesced paste.
                // Anything bigger (the final result) stays on the deferred
                // paste path below. Kill switch: OPENCUES_MSAA_ANIMATE=0.
                if (TryTypeMicroEdit(text)) return;
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
                // WPF, Notepad, Explorer). Whole-value replace, instant.
                object vp;
                if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vp) && !((ValuePattern)vp).Current.IsReadOnly)
                {
                    string prevSent = _lastSentText;
                    bool streamStart = !_bracketOpen;
                    string editCls; IntPtr editHwnd = IntPtr.Zero;
                    try { editHwnd = new IntPtr(el.Current.NativeWindowHandle); } catch { }
                    bool isEditHwnd = IsEditClassHwnd(editHwnd, out editCls);
                    // Non-Edit UIA composers (Slack): SetValue is a whole-value
                    // replace, so writing every ANIMATION FRAME that way resets
                    // the caret ~13x/sec - the visible bouncing. Type the
                    // spinner frames through the real input pipeline instead
                    // (Discord's model): relative typed frames anchored by the
                    // absolute SetValue FINAL below, and editor-safe by
                    // construction (input events, not DOM mutation - see the
                    // Slate-ghost finding). Must run BEFORE NoteSelfWrite: the
                    // micro-edit diffs against _lastSentText. Edit-family HWNDs
                    // (Notepad/WordPad) skip this - their convergent EM path is
                    // strictly better (positioned writes, no caret reset at all).
                    if (!isEditHwnd && TryTypeMicroEdit(text)) return;
                    NoteSelfWrite(text);
                    // Convergent EM path (Edit/RichEdit HWNDs): absolute writes
                    // computed against the real buffer (no drift) + native undo.
                    if (isEditHwnd && TryEmConvergentWrite(el, (ValuePattern)vp, text, streamStart)) return;
                    // Slack (Quill/Chromium): SetValue makes EVERY \n a paragraph
                    // block - even a single \n renders with a blank-line gap, so
                    // the signature lines that should be adjacent get spaced out.
                    // Slack's PASTE handler instead treats \n as a SOFT line break
                    // (adjacent) and \n\n as a blank line - i.e. it renders like
                    // Notepad. Route the FINAL substitution through paste (the
                    // spinner frames already took the typed micro-edit path above,
                    // so only this one write pays the select-all highlight).
                    if (PastePreferredApps.Contains(_lastApp))
                    {
                        PasteReplace(text, prevSent);
                        Log("debug", "applied substitution (" + text.Length + " chars, paste [Slack soft-break])");
                        return;
                    }
                    // Non-Edit UIA composer or an EM verify-fail -> absolute
                    // SetValue. SetValue resets the caret to the START, so skip
                    // the restore on animation frames (same-length 1-2 char swap)
                    // and only restore on the real substitution - no per-frame
                    // caret churn.
                    ((ValuePattern)vp).SetValue(text);
                    if (!LooksLikeAnimationFrame(prevSent, text))
                    {
                        RestoreCaretToEnd(el);
                        _caretRestoreUntil = Environment.TickCount + 600;
                    }
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
                    NoteSelfWrite(text);
                    PasteReplace(text, oldText);
                    Log("debug", "applied substitution (" + text.Length + " chars, paste)");
                    return;
                }
                Log("warn", "focused field can't be written (no ValuePattern or TextPattern)");
            }
            catch (Exception ex) { Log("warn", "set-text failed: " + ex.Message); }
        }

        // A loading-animation frame is a SAME-LENGTH swap of 1-2 chars vs the
        // previous write (the spinner glyph replacing `_`, or the next frame).
        // A genuine substitution changes many chars and/or the length. Used to
        // skip the per-frame caret restore so the caret doesn't jump during the
        // spinner. Never misfires on a real substitution (those differ widely
        // or in length; even a rare same-length <=2-char substitute only leaves
        // the caret at the field start for one write - cosmetic, self-corrects).
        static bool LooksLikeAnimationFrame(string prev, string next)
        {
            if (prev == null || next == null || prev.Length != next.Length) return false;
            int diffs = 0;
            for (int i = 0; i < prev.Length; i++)
                if (prev[i] != next[i]) { if (++diffs > 2) return false; }
            return diffs > 0;
        }

        // ValuePattern.SetValue resets the caret (Notepad drops it to the
        // START of the field), but the user's typing position was at the end
        // of what they typed - the phase-1 cursor model. For Edit-family
        // HWNDs, put the caret back at end-of-text with EM_SETSEL using a
        // huge offset (the control CLAMPS it to the text end, so there is no
        // index arithmetic to skew on CRLF), then EM_SCROLLCARET so it's
        // visible. Non-Edit HWNDs (WPF etc.) are left alone - a wrong guess
        // here is worse than the status quo. Message-based (no focus theft),
        // SendMessageTimeout(ABORTIFHUNG) so a wedged app can't hang us.
        const uint EM_GETSEL = 0x00B0;
        const uint EM_SETSEL = 0x00B1;
        const uint EM_SCROLLCARET = 0x00B7;
        const uint EM_REPLACESEL = 0x00C2;
        const uint SMTO_ABORTIFHUNG = 0x0002;
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeoutMs, out IntPtr result);
        // EM_REPLACESEL passes the replacement text as lParam (LPCTSTR); same
        // export as SendMessageTimeoutW, typed for a string arg.
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "SendMessageTimeoutW")]
        static extern IntPtr SendMessageTimeoutText(IntPtr hWnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeoutMs, out IntPtr result);
        // EM_HIDESELECTION (RichEdit) suppresses drawing the SELECTION
        // highlight only - the text keeps painting live, but our transient
        // EM_SETSEL never flashes blue. RichEdit-only (WordPad RICHEDIT50W /
        // Notepad RichEditD2DPT); a harmless no-op on classic "Edit". Toggled
        // around each write (can't stay on, or the user's own selections would
        // be invisible), but with no repaint churn - lighter than WM_SETREDRAW.
        const uint EM_HIDESELECTION = 0x043F;   // WM_USER + 63

        static void RestoreCaretToEnd(AutomationElement el, bool quiet = false)
        {
            try
            {
                IntPtr hwnd = new IntPtr(el.Current.NativeWindowHandle);
                string c = null;
                if (hwnd != IntPtr.Zero)
                {
                    var sb = new StringBuilder(256);
                    if (GetClassName(hwnd, sb, sb.Capacity) != 0) c = sb.ToString().ToLowerInvariant();
                }
                // Classic Win32 "Edit", RichEdit variants (Win11 Notepad
                // "RichEditD2DPT", WordPad "RICHEDIT50W"), WinForms TextBox
                // ("WindowsForms10.EDIT.app...") speak EM_* messages.
                if (c != null && (c == "edit" || c.Contains("richedit") || c.Contains(".edit.")))
                {
                    IntPtr res;
                    // Clamp to absolute end - the control clamps the oversized
                    // offset itself, no index arithmetic to skew. This is
                    // correct because reads STRIP WordPad's phantom final
                    // paragraph mark before it can leak into the mirror (see
                    // StripPhantomTrailingSeparator) - so text we write never
                    // carries a trailing separator the user didn't type, and
                    // absolute end IS end-of-visible-content.
                    IntPtr ok1 = SendMessageTimeoutW(hwnd, EM_SETSEL, new IntPtr(0x7FFFFFFF), new IntPtr(0x7FFFFFFF), SMTO_ABORTIFHUNG, 1000, out res);
                    IntPtr ok2 = SendMessageTimeoutW(hwnd, EM_SCROLLCARET, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 1000, out res);
                    if (!quiet)
                    {
                        IntPtr sel;
                        SendMessageTimeoutW(hwnd, EM_GETSEL, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 1000, out sel);
                        Log("debug", "caret restore: EM_SETSEL on '" + c + "' ok=" + (ok1 != IntPtr.Zero) + "/" + (ok2 != IntPtr.Zero)
                            + " sel=" + ((sel.ToInt64() >> 16) & 0xFFFF));
                    }
                    return;
                }
                // Non-Edit UIA composers (Slack and other Chromium-UIA
                // fields, which often have NO per-field HWND at all):
                // SetValue parks the caret at the START, so every animation
                // frame yanked it to the front. Try a TextPattern
                // degenerate-range Select (Chromium honours it as a caret
                // move); fields that don't expose TextPattern get a
                // synthetic Ctrl+End instead (the field IS focused - that's
                // how we attached). Chromium may also apply SetValue's caret
                // reset ASYNCHRONOUSLY after this runs, so ApplySetText arms
                // a short reassert window (MaybeReassertCaret) that re-runs
                // this on following ticks to win that race.
                // Native-UIA restore FIRST: Chromium serves TextPattern + a
                // working collapsed-range Select() only to a NATIVE IUIAutomation
                // client (the managed client below sees TextPattern=False on
                // Slack - probed 2026-07-10). Silent - no key synthesis, no
                // focus dependency quirks. Falls through to the managed attempt
                // + Ctrl+End when unavailable.
                if (TryNativeUiaCaretToEnd())
                {
                    if (!quiet) Log("debug", "caret restore: native-UIA select-at-end");
                    return;
                }
                object tpObj;
                if (el.TryGetCurrentPattern(TextPattern.Pattern, out tpObj))
                {
                    try
                    {
                        TextPatternRange range = ((TextPattern)tpObj).DocumentRange.Clone();
                        range.MoveEndpointByRange(TextPatternRangeEndpoint.Start, range, TextPatternRangeEndpoint.End);
                        range.Select();
                        if (!quiet) Log("debug", "caret restore: TextPattern select-at-end");
                        return;
                    }
                    catch (Exception ex)
                    {
                        if (!quiet) Log("debug", "caret restore: TextPattern select failed (" + ex.Message + ") - falling back to Ctrl+End");
                    }
                }
                else if (!quiet) Log("debug", "caret restore: no TextPattern on field - falling back to Ctrl+End");
                KeyChord(VK_CONTROL, VK_END);
            }
            catch { }   // caret restore is best-effort; the text write already landed
        }

        // -- Native IUIAutomation (COM) - OBSERVATION ONLY -----------------
        // Chromium/Electron serves its modern UIA provider (TextPattern with a
        // working collapsed-range Select(), i.e. real caret positioning) ONLY
        // to a native IUIAutomation client - what Narrator uses. The managed
        // System.Windows.Automation client used everywhere else in this shim
        // never sees it (Slack: TextPattern False managed / True native -
        // probed 2026-07-10 with uia-native-drive-probe.ps1).
        //
        // HARD RULE: this surface is for READS and SELECTION/CARET only -
        // selection ops (collapsed caret moves, select-all) sync into the
        // editor's model and are safe. CONTENT mutation is banned: writing
        // through it (ValuePattern.SetValue) DESYNCED Discord's Slate editor -
        // ghost text the user cannot delete, broken input until Ctrl+R. See
        // IMPLEMENTATION.md sec.5 "the Slate ghost". Do not add a content write.
        //
        // The client is created LAZILY on the first non-Edit caret restore
        // (i.e. only when a Slack-class composer is actually being written),
        // so sessions that never touch such a composer never flip Chromium
        // apps into UIA mode. Interfaces are PARTIAL vtables - methods are
        // declared in IDL order up to the last slot we call; do not reorder.
        [StructLayout(LayoutKind.Sequential)]
        struct UiaPt { public int x; public int y; }

        [ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IUIAutomationN
        {
            [PreserveSig] int CompareElements(IntPtr a, IntPtr b, out int same);
            [PreserveSig] int CompareRuntimeIds(IntPtr a, IntPtr b, out int same);
            [PreserveSig] int GetRootElement(out IUIAutomationElementN root);
            [PreserveSig] int ElementFromHandle(IntPtr hwnd, out IUIAutomationElementN element);
            [PreserveSig] int ElementFromPoint(UiaPt pt, out IUIAutomationElementN element);
            [PreserveSig] int GetFocusedElement(out IUIAutomationElementN element);
        }

        [ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IUIAutomationElementN
        {
            [PreserveSig] int SetFocus();
            [PreserveSig] int GetRuntimeId(out IntPtr rid);
            [PreserveSig] int FindFirst(int scope, IntPtr cond, out IUIAutomationElementN found);
            [PreserveSig] int FindAll(int scope, IntPtr cond, out IntPtr found);
            [PreserveSig] int FindFirstBuildCache(int scope, IntPtr cond, IntPtr req, out IUIAutomationElementN found);
            [PreserveSig] int FindAllBuildCache(int scope, IntPtr cond, IntPtr req, out IntPtr found);
            [PreserveSig] int BuildUpdatedCache(IntPtr req, out IUIAutomationElementN updated);
            [PreserveSig] int GetCurrentPropertyValue(int propertyId, [MarshalAs(UnmanagedType.Struct)] out object retVal);
            [PreserveSig] int GetCurrentPropertyValueEx(int propertyId, int ignoreDefault, [MarshalAs(UnmanagedType.Struct)] out object retVal);
            [PreserveSig] int GetCachedPropertyValue(int propertyId, [MarshalAs(UnmanagedType.Struct)] out object retVal);
            [PreserveSig] int GetCachedPropertyValueEx(int propertyId, int ignoreDefault, [MarshalAs(UnmanagedType.Struct)] out object retVal);
            [PreserveSig] int GetCurrentPatternAs(int patternId, ref Guid riid, out IntPtr pat);
            [PreserveSig] int GetCachedPatternAs(int patternId, ref Guid riid, out IntPtr pat);
            [PreserveSig] int GetCurrentPattern(int patternId, [MarshalAs(UnmanagedType.IUnknown)] out object pat);
        }

        [ComImport, Guid("a543cc6a-f4ae-494b-8239-c814481187a8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IUIAutomationTextRangeN
        {
            [PreserveSig] int Clone(out IUIAutomationTextRangeN clonedRange);
            [PreserveSig] int Compare(IUIAutomationTextRangeN range, out int areSame);
            [PreserveSig] int CompareEndpoints(int srcEndpoint, IUIAutomationTextRangeN range, int targetEndpoint, out int compValue);
            [PreserveSig] int ExpandToEnclosingUnit(int textUnit);
            [PreserveSig] int FindAttribute(int attr, [MarshalAs(UnmanagedType.Struct)] object val, int backward, out IUIAutomationTextRangeN found);
            [PreserveSig] int FindText([MarshalAs(UnmanagedType.BStr)] string text, int backward, int ignoreCase, out IUIAutomationTextRangeN found);
            [PreserveSig] int GetAttributeValue(int attr, [MarshalAs(UnmanagedType.Struct)] out object value);
            [PreserveSig] int GetBoundingRectangles(out IntPtr boundingRects);
            [PreserveSig] int GetEnclosingElement(out IUIAutomationElementN enclosingElement);
            [PreserveSig] int GetText(int maxLength, [MarshalAs(UnmanagedType.BStr)] out string text);
            [PreserveSig] int Move(int unit, int count, out int moved);
            [PreserveSig] int MoveEndpointByUnit(int endpoint, int unit, int count, out int moved);
            [PreserveSig] int MoveEndpointByRange(int srcEndpoint, IUIAutomationTextRangeN range, int targetEndpoint);
            [PreserveSig] int Select();
            [PreserveSig] int AddToSelection();
            [PreserveSig] int RemoveFromSelection();
            [PreserveSig] int ScrollIntoView(int alignToTop);
            [PreserveSig] int GetChildren(out IntPtr children);
        }

        [ComImport, Guid("32eba289-3583-42c9-9c59-3b6d9a1e9b6a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IUIAutomationTextPatternN
        {
            [PreserveSig] int RangeFromPoint(UiaPt pt, out IUIAutomationTextRangeN range);
            [PreserveSig] int RangeFromChild(IUIAutomationElementN child, out IUIAutomationTextRangeN range);
            [PreserveSig] int GetSelection(out IntPtr ranges);
            [PreserveSig] int GetVisibleRanges(out IntPtr ranges);
            [PreserveSig] int get_DocumentRange(out IUIAutomationTextRangeN range);
            [PreserveSig] int get_SupportedTextSelection(out int supportedTextSelection);
        }

        // Same GUID as IUIAutomationTextPatternN, with GetSelection marshaled
        // as a real SAFEARRAY(IUnknown) -> object[] so the live selection can
        // be READ BACK (the verification half of the verified select-all).
        // Two [ComImport] interfaces may share a GUID; 'as' QIs by GUID.
        [ComImport, Guid("32eba289-3583-42c9-9c59-3b6d9a1e9b6a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IUIAutomationTextPatternSelN
        {
            [PreserveSig] int RangeFromPoint(UiaPt pt, out IUIAutomationTextRangeN range);
            [PreserveSig] int RangeFromChild(IUIAutomationElementN child, out IUIAutomationTextRangeN range);
            [PreserveSig] int GetSelection([MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_UNKNOWN)] out object[] ranges);
            [PreserveSig] int GetVisibleRanges(out IntPtr ranges);
            [PreserveSig] int get_DocumentRange(out IUIAutomationTextRangeN range);
            [PreserveSig] int get_SupportedTextSelection(out int supportedTextSelection);
        }

        const int UIA_TextPatternId_N = 10014;
        const int EPT_Start = 0;   // TextPatternRangeEndpoint_Start
        const int EPT_End = 1;     // TextPatternRangeEndpoint_End

        static IUIAutomationN _nativeUia;
        static bool _nativeUiaFailed;
        static IUIAutomationN NativeUia()
        {
            if (_nativeUia != null || _nativeUiaFailed) return _nativeUia;
            try
            {
                object o = null;
                Type t8 = Type.GetTypeFromCLSID(new Guid("E22AD333-B25F-460C-83D0-0581107395C9"), false);   // CUIAutomation8
                if (t8 != null) { try { o = Activator.CreateInstance(t8); } catch { } }
                if (o == null) o = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("FF48DBA4-60EF-4201-AA87-54103EEF594E"), true));   // CUIAutomation
                _nativeUia = (IUIAutomationN)o;
            }
            catch (Exception ex) { _nativeUiaFailed = true; Log("debug", "native UIA client unavailable: " + ex.Message); }
            return _nativeUia;
        }

        // Move the caret to end-of-content on the FOCUSED element via the
        // native TextPattern: collapse the document range to its END and
        // Select() it (a degenerate selection IS a caret). Returns false when
        // the provider doesn't serve the surface - the caller's ladder
        // (managed TextPattern, then Ctrl+End) takes over.
        static bool TryNativeUiaCaretToEnd()
        {
            try
            {
                var uia = NativeUia();
                if (uia == null) return false;
                IUIAutomationElementN el;
                if (uia.GetFocusedElement(out el) != 0 || el == null) return false;
                object po;
                if (el.GetCurrentPattern(UIA_TextPatternId_N, out po) != 0 || po == null) return false;
                var tp = po as IUIAutomationTextPatternN;
                if (tp == null) return false;
                IUIAutomationTextRangeN doc, endR;
                if (tp.get_DocumentRange(out doc) != 0 || doc == null) return false;
                if (doc.Clone(out endR) != 0 || endR == null) return false;
                if (endR.MoveEndpointByRange(EPT_Start, doc, EPT_End) != 0) return false;
                return endR.Select() == 0;
            }
            catch { return false; }
        }

        // Select the ENTIRE document of the focused composer via the native
        // TextPattern and VERIFY it took: read the selection back and compare
        // endpoints against the document range. A verified selection lets the
        // paste path skip the blind keystroke sequence (Ctrl+A + commit gaps +
        // Delete-to-empty): one Ctrl+V over a selection we KNOW is committed.
        // This is a selection op - the safe half of native UIA on Slate (the
        // ghost came from content mutation). Returns false -> caller falls
        // back to the legacy gap-timed sequence.
        // Logged once per session: WHY the verified select-all path declined,
        // so a fallback-to-legacy-flash is diagnosable from the log without a
        // debug build. (It failed silently on Discord on first ship - never
        // let this path decline silently again.)
        static bool _selAllDiagLogged;
        static bool SelAllFail(string why)
        {
            if (!_selAllDiagLogged)
            {
                _selAllDiagLogged = true;
                Log("debug", "native select-all: falling back to keystroke sequence (" + why + ")");
            }
            return false;
        }

        static bool TryNativeUiaSelectAllVerified()
        {
            try
            {
                var uia = NativeUia();
                if (uia == null) return SelAllFail("no native UIA client");
                IUIAutomationElementN el;
                int hr = uia.GetFocusedElement(out el);
                if (hr != 0 || el == null) return SelAllFail("GetFocusedElement hr=0x" + hr.ToString("x8"));
                object po;
                hr = el.GetCurrentPattern(UIA_TextPatternId_N, out po);
                if (hr != 0 || po == null) return SelAllFail("no TextPattern hr=0x" + hr.ToString("x8"));
                var tp = po as IUIAutomationTextPatternN;
                var tps = po as IUIAutomationTextPatternSelN;
                if (tp == null) return SelAllFail("TextPattern QI null");
                if (tps == null) return SelAllFail("GetSelection variant QI null");
                IUIAutomationTextRangeN doc;
                hr = tp.get_DocumentRange(out doc);
                if (hr != 0 || doc == null) return SelAllFail("DocumentRange hr=0x" + hr.ToString("x8"));
                hr = doc.Select();
                if (hr != 0) return SelAllFail("Select hr=0x" + hr.ToString("x8"));
                // Verify (up to 3 x 20ms): the provider's reported selection
                // must span the document exactly. This replaces the blind 90ms
                // commit gap with knowledge.
                string last = "no selection reported";
                for (int attempt = 0; attempt < 3; attempt++)
                {
                    Thread.Sleep(20);
                    object[] ranges;
                    hr = tps.GetSelection(out ranges);
                    if (hr != 0) { last = "GetSelection hr=0x" + hr.ToString("x8"); continue; }
                    if (ranges == null || ranges.Length == 0) { last = "GetSelection empty"; continue; }
                    var sel = ranges[0] as IUIAutomationTextRangeN;
                    if (sel == null) { last = "selection range QI null"; continue; }
                    int cs, ce;
                    if (sel.CompareEndpoints(EPT_Start, doc, EPT_Start, out cs) == 0 && cs == 0
                        && sel.CompareEndpoints(EPT_End, doc, EPT_End, out ce) == 0 && ce == 0)
                        return true;
                    last = "selection != document (endpoints off)";
                }
                return SelAllFail("verify failed: " + last);
            }
            catch (Exception ex) { return SelAllFail("threw: " + ex.Message); }
        }

        // Chromium applies SetValue (and its caret-to-start reset) on its own
        // schedule; a caret restore issued immediately after the write can
        // run BEFORE the reset it is meant to undo. ApplySetText arms this
        // window; each poll tick inside it re-asserts end-of-text so the
        // last write of a burst (the final result) ends with the caret where
        // the user left it.
        static int _caretRestoreUntil = 0;
        static void MaybeReassertCaret()
        {
            if (_attachMode != AttachMode.Uia || !_attached) return;
            if (unchecked(Environment.TickCount - _caretRestoreUntil) >= 0) return;
            AutomationElement el = null;
            try { el = AutomationElement.FocusedElement; } catch { }
            if (el != null) RestoreCaretToEnd(el, true);
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
            NoteSelfWrite(text);
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
        const uint KEYEVENTF_UNICODE = 0x0004;
        const ushort VK_CONTROL = 0x11;
        const ushort VK_A = 0x41;
        const ushort VK_V = 0x56;
        const ushort VK_BACK = 0x08;
        const ushort VK_END = 0x23;
        const ushort VK_DELETE = 0x2E;

        static INPUT KeyInput(ushort vk, bool up)
        {
            return new INPUT
            {
                type = INPUT_KEYBOARD,
                U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = up ? KEYEVENTF_KEYUP : 0, time = 0, dwExtraInfo = IntPtr.Zero } },
            };
        }

        // A literal unicode character as synthetic typing (layout-independent;
        // BMP chars in one event, surrogate pairs as two - apps reassemble).
        static INPUT UnicodeInput(char ch, bool up)
        {
            return new INPUT
            {
                type = INPUT_KEYBOARD,
                U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = (up ? KEYEVENTF_KEYUP : 0) | KEYEVENTF_UNICODE, time = 0, dwExtraInfo = IntPtr.Zero } },
            };
        }

        // The typed micro-frame path for LOADING-ANIMATION frames, shared by
        // the two attach modes where the app has no positioned-write API:
        //   * MSAA/Electron (Discord)  - below the deferred Ctrl+A+paste tier
        //   * non-Edit UIA  (Slack)    - below the whole-value SetValue final
        // Only for edits small enough to be indistinguishable from a human
        // typing; goes through the real input pipeline (SendInput), so it is
        // editor-framework-safe (Slate/Quill process it as genuine input) and
        // never resets the caret. Relative - acceptable ONLY because the final
        // write on both paths is an absolute anchor (paste / SetValue) that
        // wipes any frame drift. NOT used on Edit-family HWNDs
        // (Notepad/WordPad): their convergent EM path is positioned AND
        // absolute, strictly better (the 63be937f revert is the history).
        // Assumes the caret sits at the end of the field (phase-1 cursor
        // model, and the state every prior write path leaves behind).
        const int MSAA_TYPE_MAX = 6;
        // Kill switch: OPENCUES_TYPE_ANIMATE=0 (legacy OPENCUES_MSAA_ANIMATE=0
        // still honoured) -> animation falls back to deferred-paste / SetValue.
        static readonly bool _typeAnimate =
            Environment.GetEnvironmentVariable("OPENCUES_TYPE_ANIMATE") != "0" &&
            Environment.GetEnvironmentVariable("OPENCUES_MSAA_ANIMATE") != "0";

        static bool TryTypeMicroEdit(string text)
        {
            if (!_typeAnimate) return false;
            if (_pendingMsaaText != null) return false;   // a big write is queued; field state mid-flight - defer
            string cur = _lastSentText;
            if (cur == null) return false;                // unknown baseline - defer to the paste path
            if (text == cur) return true;                 // nothing to write
            int p = CommonPrefixLen(cur, text);
            int del = cur.Length - p;
            int add = text.Length - p;
            if (del > MSAA_TYPE_MAX || add > MSAA_TYPE_MAX) return false;
            string tail = text.Substring(p);
            if (tail.IndexOf('\n') >= 0 || tail.IndexOf('\r') >= 0) return false;
            // Read-before-write: the diff above is computed against
            // `_lastSentText` - the shim's MODEL of the field, which goes
            // stale the instant the USER types (phase 1 has no keyboard
            // hook, so user keystrokes are invisible until the next event
            // read). Sending backspaces against a stale model deletes user
            // content - live incident 2026-07-14: an animation frame burst
            // ate the leading chars of "congratulations" mid-typing. Verify
            // the field still matches the model; on divergence DROP the
            // frame (animation is cosmetic - the final substitution write
            // is an absolute anchor that never depends on frames landing).
            // Read failure keeps the prior trust-the-model behaviour.
            string live;
            if (TryReadCurrentField(out live) && live != null && EolNorm(live) != EolNorm(cur))
            {
                Log("debug", "micro-frame skipped: field diverged from model ("
                    + cur.Length + " -> " + live.Length + " chars; user typing?)");
                return true;   // swallow the frame; never write against a stale model
            }
            NoteSelfWrite(text);
            var inputs = new INPUT[del * 2 + tail.Length * 2];
            int k = 0;
            for (int i = 0; i < del; i++)
            {
                inputs[k++] = KeyInput(VK_BACK, false);
                inputs[k++] = KeyInput(VK_BACK, true);
            }
            for (int i = 0; i < tail.Length; i++)
            {
                inputs[k++] = UnicodeInput(tail[i], false);
                inputs[k++] = UnicodeInput(tail[i], true);
            }
            if (inputs.Length > 0)
                SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            Log("debug", "applied substitution (" + text.Length + " chars, typed micro-frame [" + (_attachMode == AttachMode.Msaa ? "msaa" : "uia") + "]: -" + del + " +" + tail.Length + ")");
            return true;
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

        // Single key press+release (no modifier). Used to DELETE a live
        // selection on the MSAA whole-field paste path.
        static void KeyTap(ushort key)
        {
            var inputs = new INPUT[] { KeyInput(key, false), KeyInput(key, true) };
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

        // Replace the field via a PREFIX DIFF instead of clearing the whole
        // field. Keep the unchanged common HEAD of old vs new; the cursor is at
        // the end, so backspace only the CHANGED SUFFIX and paste only the new
        // tail. No selection -> NOTHING to flash, and both halves (backspaces +
        // paste) go through the real input pipeline, so it is editor-framework-
        // safe (the same mechanism as the per-frame typed animation, in one
        // atomic burst). The ceiling bounds the CHANGED SUFFIX, not the whole
        // field; only a rewrite bigger than it falls to the select-all path.
        // CEILING = 40, and this is EMPIRICAL - do not raise it casually: a
        // 2026-07-10 live test at 600 sent a 354-backspace burst into
        // Discord/Slate and it failed outright ("doesn't work at all" -
        // dropped/coalesced under load, mangled result), while the small
        // bursts this path has always used (<=40, and the 1-2-char animation
        // frames) are reliable. Large rewrites take the select-all path and
        // pay one highlight flash - on Slate that is the floor, since every
        // flash-free alternative is closed: SetValue desyncs the model (the
        // ghost), typing the result triggers Discord's :/@/# popups, and big
        // backspace bursts drop. No margin on the count: the common prefix
        // must be preserved exactly (an extra backspace would eat unchanged
        // head text). Tunable for experiments: OPENCUES_BACKSPACE_MAX.
        // `oldText` is the field's current content the shim last read.
        static readonly int _backspaceMax = ReadBackspaceMax();
        static int ReadBackspaceMax()
        {
            var v = Environment.GetEnvironmentVariable("OPENCUES_BACKSPACE_MAX");
            int m;
            if (!string.IsNullOrEmpty(v) && int.TryParse(v, out m) && m >= 0 && m <= 4000) return m;
            return 40;
        }
        // Read the attached field's CURRENT text on demand, mode-aware.
        // Used by the write paths to verify their model of the field
        // (`oldText` / `_lastSentText`) against reality IMMEDIATELY before
        // acting, and by PasteReplace to verify paste consumption before
        // restoring the user's clipboard. Returns false when no readable
        // field is attached (write paths then fall back to their prior
        // trust-the-model behaviour).
        static bool TryReadCurrentField(out string cur)
        {
            cur = null;
            try
            {
                if (_attachMode == AttachMode.Msaa)
                {
                    int nodeId;
                    return TryReadFocusedElectron(out cur, out nodeId) && cur != null;
                }
                var el = _hookedEl;
                if (el == null) return false;
                cur = ReadValue(el);
                return cur != null;
            }
            catch { return false; }
        }

        // How long PasteReplace waits for the target app to CONSUME the
        // paste before restoring the user's previous clipboard. Discord
        // under load was observed consuming >1.1s after Ctrl+V; the old
        // fixed 300ms restore raced it and the paste delivered the
        // RESTORED (user's) clipboard into the field - live incident
        // 2026-07-14: a copied email address replaced the substitution.
        static readonly int _clipRestoreMaxMs = ReadClipRestoreMaxMs();
        static int ReadClipRestoreMaxMs()
        {
            var v = Environment.GetEnvironmentVariable("OPENCUES_CLIPBOARD_RESTORE_MAX_MS");
            int m;
            if (!string.IsNullOrEmpty(v) && int.TryParse(v, out m) && m >= 300 && m <= 15000) return m;
            return 3000;
        }

        // Lowercased-alphanumeric fold for paste-consumption matching.
        // Discord/Slate re-dress pasted text in accValue readbacks (emoji
        // as object chars, markdown handling, trailing dress), so byte
        // equality - even EolNorm-folded - can fail on a paste that
        // plainly landed, and the fail-safe would then eat the user's
        // clipboard restore on EVERY big substitution (observed live
        // 2026-07-14 18:35: paste landed, bracket reconciled, verify
        // still timed out). Folding both sides to [a-z0-9] and checking
        // the readback CONTAINS a prefix window of the pasted text
        // survives any dress the app applies to punctuation/emoji/EOLs.
        static string AlnumFold(string s, int max)
        {
            if (s == null) return "";
            var sb = new StringBuilder(Math.Min(s.Length, max));
            for (int i = 0; i < s.Length && sb.Length < max; i++)
            {
                char c = s[i];
                if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) sb.Append(c);
                else if (c >= 'A' && c <= 'Z') sb.Append((char)(c + 32));
            }
            return sb.ToString();
        }

        static void PasteReplace(string text, string oldText)
        {
            string saved = null;
            try { saved = GetClipboardText(); } catch { }

            // Verify the field model against reality before computing the
            // diff. `oldText` is the daemon's last read - if the user typed
            // (or the app edited) since, backspacing `oldLen - p` chars
            // deletes USER content (the 2026-07-14 "congratulations" ->
            // "gratulations" class). A fresh read supersedes the parameter;
            // read failure keeps the prior trust-the-model behaviour.
            string fresh;
            if (TryReadCurrentField(out fresh) && fresh != oldText)
            {
                Log("debug", "diff-paste: field diverged from model (" + (oldText != null ? oldText.Length : 0)
                    + " -> " + fresh.Length + " chars), rebasing diff on fresh read");
                oldText = fresh;
            }

            int oldLen = oldText != null ? oldText.Length : 0;
            int p = CommonPrefixLen(oldText, text);   // unchanged head we keep
            int changed = oldLen - p;                 // suffix chars to delete (cursor is at end)

            Log("debug", "diff-paste: prefix=" + p + " changed=" + changed + "/" + oldLen + " newLen=" + text.Length
                + (changed <= _backspaceMax ? " -> backspace (no flash)" : " -> Ctrl+A (flash)"));

            if (changed <= _backspaceMax)
            {
                // Small tail edit (append / truncate / trailing replace): delete
                // the changed suffix, paste only the new tail. No selection ->
                // no flash. Works regardless of total field size.
                string tail = text.Substring(p);   // p <= min(oldLen, textLen) <= textLen
                SetClipboardText(tail);
                Thread.Sleep(15);
                ClearAndPaste(changed);   // `changed` backspaces + Ctrl+V (pastes tail), one burst
            }
            else
            {
                // Whole-field rewrite (no small tail to exploit).
                SetClipboardText(text);
                Thread.Sleep(15);
                // Preferred: native-UIA VERIFIED select-all -> immediate paste.
                // The selection is set by API (no keystroke race) and read back
                // from the provider, so we KNOW it is committed before Ctrl+V -
                // the append bug (paste landing before an uncommitted Ctrl+A)
                // cannot happen, which also makes the Delete-to-empty step and
                // its blank-field frame unnecessary. Flash shrinks from
                // blue->empty->text (~200ms of gaps) to one blue->text swap.
                if (TryNativeUiaSelectAllVerified())
                {
                    Log("debug", "diff-paste: native-UIA verified select-all -> paste");
                    KeyChord(VK_CONTROL, VK_V);   // paste over the verified selection
                }
                else
                {
                    // Legacy sequence: select-all, DELETE the selection to empty
                    // the field, then paste into the empty field. Pasting into a
                    // guaranteed-empty field CANNOT append old content - the
                    // failure mode on slow Electron composers (Discord), where a
                    // fast Ctrl+A->Ctrl+V pasted before the selection committed,
                    // leaving old text + new appended. Each step is its own
                    // burst with a commit gap so the slow composer processes the
                    // selection before the delete, and the delete before the
                    // paste. 90ms default (Discord needs ~50ms+;
                    // OPENCUES_PASTE_GAP_MS overrides for slower machines).
                    int commitMs = _pasteGapMs > 0 ? _pasteGapMs : 90;
                    KeyChord(VK_CONTROL, VK_A);
                    Thread.Sleep(commitMs);
                    KeyTap(VK_DELETE);            // clear the selection -> field now empty
                    Thread.Sleep(commitMs);
                    KeyChord(VK_CONTROL, VK_V);   // paste into the empty field
                }
            }
            // Electron reads the clipboard ASYNCHRONOUSLY after Ctrl+V - and
            // NOT on a bounded schedule: Discord under load was observed
            // consuming >1.1s later. Restoring the user's clipboard on a
            // fixed timer therefore RACES the read; when the restore wins,
            // the paste delivers the user's OLD clipboard into the focused
            // app (live incident 2026-07-14: a copied email address landed
            // in a Discord input instead of the substitution - a clipboard
            // LEAK into whatever app is focused, not just a wrong render).
            //
            // Verify consumption instead: poll the field until it reflects
            // the pasted text (EolNorm both sides - apps re-render newlines,
            // see the newline-rendering table), THEN restore. On timeout or
            // an unreadable field, FAIL SAFE: skip the restore entirely -
            // losing the user's old clipboard contents is an annoyance;
            // pasting them into the foreground app is a leak. Window is
            // tunable via OPENCUES_CLIPBOARD_RESTORE_MAX_MS (default 3000).
            if (saved != null)
            {
                bool consumed = false;
                int deadline = unchecked(Environment.TickCount + _clipRestoreMaxMs);
                string want = EolNorm(text);
                // Fold-tolerant fallback: >=12 fold chars required so a
                // short/generic paste ("ok") can't false-match text that
                // was already in the field; shorter pastes verify by the
                // exact path only.
                string wantFold = AlnumFold(text, 24);
                bool foldUsable = wantFold.Length >= 12;
                while (unchecked(deadline - Environment.TickCount) > 0)
                {
                    Thread.Sleep(50);
                    string now;
                    if (!TryReadCurrentField(out now) || now == null) continue;
                    if (EolNorm(now) == want) { consumed = true; break; }
                    if (foldUsable && AlnumFold(now, 4000).Contains(wantFold)) { consumed = true; break; }
                }
                if (consumed)
                {
                    try { SetClipboardText(saved); } catch { }
                    Log("debug", "clipboard restored after verified paste consumption");
                }
                else
                {
                    Log("warn", "clipboard NOT restored: paste consumption unverified after "
                        + _clipRestoreMaxMs + "ms - refusing to race the app's async clipboard read"
                        + " (restoring early can paste the user's old clipboard into the field)."
                        + " Previous clipboard contents were replaced by the substitution text.");
                }
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

        static int CommonSuffixLen(string a, string b, int prefix)
        {
            if (a == null || b == null) return 0;
            int n = Math.Min(a.Length, b.Length) - prefix;
            int i = 0;
            while (i < n && a[a.Length - 1 - i] == b[b.Length - 1 - i]) i++;
            return i;
        }

        // A small local change (a loading-animation spinner frame) vs a large
        // one (the real substitution). Measured as the changed span each way.
        static bool IsSmallDelta(string a, string b)
        {
            int p = CommonPrefixLen(a, b);
            int s = CommonSuffixLen(a, b, p);
            return (a.Length - p - s) <= 4 && (b.Length - p - s) <= 4;
        }

        // Edit-family window classes that speak EM_* messages: classic Win32
        // "Edit", every RichEdit variant (WordPad "RICHEDIT50W", Win11 Notepad
        // "RichEditD2DPT"), and WinForms TextBox ("WindowsForms10.EDIT.app...").
        // WPF / Chromium-UIA composers have no per-field HWND of this class, so
        // they never match and stay on the absolute SetValue path.
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

        // The user's pre-substitution text (their `_` command), read at the
        // start of a write stream so the final undoable write can make one
        // Ctrl+Z land on it.
        static string _emUndoBaseline = null;

        // -- The convergent write surface (Edit/RichEdit HWNDs) --------------
        // Every write is ABSOLUTE (select-all -> EM_REPLACESEL of the whole
        // value) and computed against the buffer's ACTUAL content (read back
        // each call), so nothing drifts - the failure mode of the relative
        // Backspace path (blind delete counts against an optimistic model ->
        // overshoot / double-delete / stray dot on a laggy buffer) cannot
        // happen here. EM_REPLACESEL also flows through the control's NATIVE
        // undo, so we keep Ctrl+Z:
        //   * animation frames  -> fUndo=FALSE  (cosmetic, no undo record)
        //   * final result      -> reset to baseline (fUndo=FALSE, wipes the
        //     animation) then write undoably (fUndo=TRUE) = ONE undo unit, so
        //     one Ctrl+Z restores the pre-command text.
        // Read-back verify (EOL-normalised); any mismatch (a control whose EM
        // index model diverges from the UIA string) returns false and the
        // caller repairs via absolute SetValue - worst case is exactly the
        // prior robust-but-no-undo behaviour. Message-based
        // (SendMessageTimeout ABORTIFHUNG): no focus theft, can't wedge.
        static bool TryEmConvergentWrite(AutomationElement el, ValuePattern vp, string text, bool streamStart)
        {
            try
            {
                string className;
                IntPtr hwnd = new IntPtr(el.Current.NativeWindowHandle);
                if (!IsEditClassHwnd(hwnd, out className)) return false;   // non-Edit -> SetValue

                // In RichEdit a bare LF via EM_REPLACESEL becomes a PARAGRAPH
                // break (CR), and paragraphs carry inter-paragraph spacing - so a
                // multi-line fill renders double-spaced (the WordPad gap). What we
                // want is a SOFT line break (what Shift+Enter inserts): lines sit
                // directly adjacent, no paragraph spacing. RichEdit's soft-break
                // char is VT (\x0B). Convert every newline to VT. EolNorm folds
                // VT/U+2028/CR/CRLF/LF together, so the verify + the daemon's
                // mirror still compare equal. Plain "edit" controls have no soft
                // break, so scope this to richedit only.
                // Scope to paragraph-spacing apps (wordpad) - NOT Notepad's
                // RichEditD2DPT, which has no inter-paragraph gap. Case-insensitive:
                // IsEditClassHwnd returns the RAW class ("RICHEDIT50W").
                string emText = text;
                if (_lastApp != null && RichEditParagraphApps.Contains(_lastApp)
                    && className != null && className.ToLowerInvariant().Contains("richedit")
                    && text.IndexOf('\n') >= 0)
                    emText = text.Replace("\r\n", "\v").Replace('\r', '\v').Replace('\n', '\v');

                string cur;
                try { cur = StripPhantomTrailingSeparator(el, vp.Current.Value ?? ""); }
                catch { return false; }                                    // can't read reality -> SetValue
                if (streamStart) _emUndoBaseline = cur;                     // the `_` command, pre-animation
                if (EolNorm(cur) == EolNorm(text)) return true;            // already there (any EOL dress)

                IntPtr res;
                if (IsSmallDelta(cur, text))
                {
                    // Animation frame: absolute whole-value replace with the
                    // SELECTION HIGHLIGHT hidden so our transient EM_SETSEL never
                    // flashes blue. Absolute (0,-1) -> no drift, no index math;
                    // fUndo=FALSE keeps it out of undo.
                    SendMessageTimeoutW(hwnd, EM_HIDESELECTION, new IntPtr(1), IntPtr.Zero, SMTO_ABORTIFHUNG, 1000, out res);
                    try
                    {
                        SendMessageTimeoutW(hwnd, EM_SETSEL, IntPtr.Zero, new IntPtr(-1), SMTO_ABORTIFHUNG, 1500, out res);
                        SendMessageTimeoutText(hwnd, EM_REPLACESEL, IntPtr.Zero /* fUndo=FALSE */, emText, SMTO_ABORTIFHUNG, 1500, out res);
                    }
                    finally
                    {
                        SendMessageTimeoutW(hwnd, EM_HIDESELECTION, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 1000, out res);
                    }
                    return true;   // frame is cosmetic; the next write self-corrects
                }

                // Final substitution: a large whole-buffer change. Do it as an
                // absolute select-all replace (skew-immune - only 0/-1), with the
                // selection highlight hidden so it never flashes blue. Baseline-
                // reset (fUndo=FALSE) then result (fUndo=TRUE) = ONE undo unit ->
                // one Ctrl+Z restores the pre-command text.
                SendMessageTimeoutW(hwnd, EM_HIDESELECTION, new IntPtr(1), IntPtr.Zero, SMTO_ABORTIFHUNG, 1000, out res);
                try
                {
                    if (_emUndoBaseline != null && _emUndoBaseline != cur)
                    {
                        SendMessageTimeoutW(hwnd, EM_SETSEL, IntPtr.Zero, new IntPtr(-1), SMTO_ABORTIFHUNG, 1500, out res);
                        SendMessageTimeoutText(hwnd, EM_REPLACESEL, IntPtr.Zero /* fUndo=FALSE */, _emUndoBaseline, SMTO_ABORTIFHUNG, 1500, out res);
                    }
                    SendMessageTimeoutW(hwnd, EM_SETSEL, IntPtr.Zero, new IntPtr(-1), SMTO_ABORTIFHUNG, 1500, out res);
                    SendMessageTimeoutText(hwnd, EM_REPLACESEL, new IntPtr(1) /* fUndo=TRUE */, emText, SMTO_ABORTIFHUNG, 1500, out res);
                    SendMessageTimeoutW(hwnd, EM_SCROLLCARET, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 1000, out res);
                }
                finally
                {
                    SendMessageTimeoutW(hwnd, EM_HIDESELECTION, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 1000, out res);
                }

                string after;
                try { after = StripPhantomTrailingSeparator(el, vp.Current.Value ?? ""); } catch { after = null; }
                if (after == null || EolNorm(after) != EolNorm(text))
                {
                    Log("warn", "EM convergent write verify mismatch on '" + className + "' (want=" + text.Length + " got=" + (after == null ? -1 : after.Length) + ") - repairing via SetValue");
                    return false;
                }
                _emUndoBaseline = null;
                Log("debug", "applied substitution (" + text.Length + " chars, EM_REPLACESEL final, class " + className + ")");
                return true;
            }
            catch (Exception ex)
            {
                Log("debug", "EM convergent write unavailable: " + ex.Message);
                return false;
            }
        }

        // n Backspaces THEN Ctrl+V, all in one atomic SendInput burst. The
        // editor processes the deletes (to empty) and the paste back-to-back off
        // its input queue with no frame rendered between - no highlight, no
        // empty-placeholder flash. Backspace deletes are sequential model edits
        // (unlike Ctrl+A, which needs a selection COMMIT the paste can outrun),
        // so the paste reliably lands in the emptied field.
        static void ClearAndPaste(int n)
        {
            if (n < 0) n = 0;
            if (n > 4000) n = 4000;
            var inputs = new INPUT[n * 2 + 4];
            int k = 0;
            for (int i = 0; i < n; i++)
            {
                inputs[k++] = KeyInput(VK_BACK, false);
                inputs[k++] = KeyInput(VK_BACK, true);
            }
            inputs[k++] = KeyInput(VK_CONTROL, false);
            inputs[k++] = KeyInput(VK_V, false);
            inputs[k++] = KeyInput(VK_V, true);
            inputs[k++] = KeyInput(VK_CONTROL, true);
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        // ================= Phase 2 ======================================
        // Keyboard-chord hook + overlay + real caret. Everything in this
        // region is additive: with the kill switches on (or on a field
        // that reports cycling=false) the shim behaves exactly like the
        // phase-1 build.

        // --- Small helpers ----------------------------------------------
        static int Num(Dictionary<string, object> m, string k, int def)
        {
            object v;
            if (m != null && m.TryGetValue(k, out v) && v is double) return (int)(double)v;
            return def;
        }

        static bool HasManagedTextPattern(AutomationElement el)
        {
            try { object tp; return el.TryGetCurrentPattern(TextPattern.Pattern, out tp); }
            catch { return false; }
        }

        // Map a char index in the shim's text model to UIA TextUnit.Character
        // counts: UIA treats a CRLF pair as ONE character, the string as two.
        static int MapStrToUiaChars(string text, int idx)
        {
            if (text == null) return idx < 0 ? 0 : idx;
            int n = Math.Min(idx < 0 ? 0 : idx, text.Length), u = 0;
            for (int i = 0; i < n; i++)
            {
                if (text[i] == '\r' && i + 1 < n && text[i + 1] == '\n') i++;
                u++;
            }
            return u;
        }

        // --- DPI awareness ----------------------------------------------
        // Overlay rects come from UIA in PHYSICAL screen pixels. If this
        // process is DPI-virtualized (powershell.exe default), WinForms
        // coordinates are scaled and every rect lands offset on HiDPI
        // monitors. Per-Monitor-V2 when available, legacy aware otherwise.
        // Must run before any window is created; a false return means the
        // host (the tray) already set awareness - fine either way.
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        static void EnsureDpiAware()
        {
            try
            {
                if (!SetProcessDpiAwarenessContext(new IntPtr(-4)))   // PER_MONITOR_AWARE_V2
                    SetProcessDPIAware();
            }
            catch { try { SetProcessDPIAware(); } catch { } }
        }

        // --- WH_KEYBOARD_LL chord hook ----------------------------------
        // Global low-level keyboard hook on its own message-pump thread.
        // While a cycling-capable field is attached (and we're enabled +
        // connected), Ctrl+Alt+Up/Down/Left/Right key-downs are SWALLOWED
        // and forwarded to the daemon as `key` messages; the matching
        // key-ups are swallowed too (no orphan key-up reaches the app).
        // If the runtime reports consumed=false in `key-result`, the
        // chord is re-injected with INJECT_MARK in dwExtraInfo so this
        // hook passes it through (the user is still physically holding
        // Ctrl+Alt, so the app sees the full chord). Escape is OBSERVED
        // (forwarded, never swallowed) - the runtime uses it to drop the
        // word highlight, the app keeps its own Escape behaviour.
        // The hook callback stays minimal: state checks + enqueue; the
        // socket write happens on the thread pool (a LL hook that blocks
        // >~300ms gets silently removed by Windows).
        const int WH_KEYBOARD_LL = 13;
        const int WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;
        const ushort VK_SHIFT = 0x10, VK_MENU = 0x12, VK_ESCAPE = 0x1B;
        const ushort VK_LEFT = 0x25, VK_UP = 0x26, VK_RIGHT = 0x27, VK_DOWN = 0x28;
        const ushort VK_LWIN = 0x5B, VK_RWIN = 0x5C;
        const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        static readonly IntPtr INJECT_MARK = new IntPtr(0x0C0E50C0);

        [StructLayout(LayoutKind.Sequential)]
        struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }
        delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
        [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
        [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll", EntryPoint = "GetMessageW")] static extern int GetMessageW(out MSG msg, IntPtr hWnd, uint min, uint max);
        [DllImport("user32.dll")] static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
        const uint WM_QUIT_MSG = 0x0012;

        static readonly bool _hookEnabled = Environment.GetEnvironmentVariable("OPENCUES_WIN_HOOK") != "0";
        static IntPtr _hookHandle = IntPtr.Zero;
        static LowLevelKeyboardProc _hookProc;   // field ref = GC pin for the delegate
        static Thread _hookThread;
        static uint _hookThreadId;
        static int _keyMsgId;
        // Arrow vks we swallowed on key-down, so the matching key-up is
        // swallowed too. Hook-thread-only - no lock.
        static readonly HashSet<uint> _swallowedDown = new HashSet<uint>();
        // key-msg id -> vk, for re-injection on consumed=false. Touched by
        // the hook thread (add) and the poll thread (remove) - locked.
        static readonly Dictionary<int, ushort> _pendingKeys = new Dictionary<int, ushort>();

        static void StartKeyHook()
        {
            if (!_hookEnabled) { Console.WriteLine("keyboard hook disabled (OPENCUES_WIN_HOOK=0)"); return; }
            if (_hookThread != null) return;
            _hookThread = new Thread(KeyHookThread) { IsBackground = true };
            _hookThread.Start();
        }

        static void StopKeyHook()
        {
            if (_hookThreadId != 0) PostThreadMessage(_hookThreadId, WM_QUIT_MSG, IntPtr.Zero, IntPtr.Zero);
        }

        static void KeyHookThread()
        {
            _hookThreadId = GetCurrentThreadId();
            _hookProc = KeyHookCallback;
            _hookHandle = SetWindowsHookEx(WH_KEYBOARD_LL, _hookProc, GetModuleHandle(null), 0);
            if (_hookHandle == IntPtr.Zero)
            {
                Log("warn", "keyboard hook install failed (err=" + Marshal.GetLastWin32Error() + ") - chords disabled");
                return;
            }
            Log("info", "keyboard hook installed (Ctrl+Alt+arrows -> runtime while a cycling field is attached)");
            MSG msg;
            while (_running && GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0) { /* pump - LL hook is serviced here */ }
            try { UnhookWindowsHookEx(_hookHandle); } catch { }
            _hookHandle = IntPtr.Zero;
        }

        static IntPtr KeyHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode < 0) return CallNextHookEx(_hookHandle, nCode, wParam, lParam);
            try
            {
                var info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                if (info.dwExtraInfo == INJECT_MARK)   // our own re-injection - pass through untouched
                    return CallNextHookEx(_hookHandle, nCode, wParam, lParam);
                int m = wParam.ToInt32();
                bool down = m == WM_KEYDOWN || m == WM_SYSKEYDOWN;
                bool up = m == WM_KEYUP || m == WM_SYSKEYUP;
                uint vk = info.vkCode;
                bool isArrow = vk == VK_UP || vk == VK_DOWN || vk == VK_LEFT || vk == VK_RIGHT;
                if (!isArrow && vk != VK_ESCAPE) return CallNextHookEx(_hookHandle, nCode, wParam, lParam);
                if (!(_attached && _enabled && _fieldCycling && Connected))
                    return CallNextHookEx(_hookHandle, nCode, wParam, lParam);
                if (vk == VK_ESCAPE)
                {
                    if (down) QueueKeyMessage("escape", 0, false);
                    return CallNextHookEx(_hookHandle, nCode, wParam, lParam);   // observe-only
                }
                if (up)
                {
                    if (_swallowedDown.Remove(vk)) return new IntPtr(1);   // pair with the swallowed down
                    return CallNextHookEx(_hookHandle, nCode, wParam, lParam);
                }
                bool ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
                bool alt = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
                if (!(ctrl && alt)) return CallNextHookEx(_hookHandle, nCode, wParam, lParam);
                _swallowedDown.Add(vk);
                QueueKeyMessage(KeyName(vk), (ushort)vk, true);
                return new IntPtr(1);   // swallow - the app never sees the chord
            }
            catch { }
            return CallNextHookEx(_hookHandle, nCode, wParam, lParam);
        }

        static string KeyName(uint vk)
        {
            switch (vk)
            {
                case VK_UP: return "up";
                case VK_DOWN: return "down";
                case VK_LEFT: return "left";
                case VK_RIGHT: return "right";
                default: return "";
            }
        }

        static void QueueKeyMessage(string key, ushort vk, bool track)
        {
            int id = Interlocked.Increment(ref _keyMsgId);
            if (track)
            {
                lock (_pendingKeys)
                {
                    if (_pendingKeys.Count > 32) _pendingKeys.Clear();   // dropped-reply hygiene
                    _pendingKeys[id] = vk;
                }
            }
            bool ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
            bool alt = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
            bool shift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
            bool meta = ((GetAsyncKeyState(VK_LWIN) & 0x8000) != 0) || ((GetAsyncKeyState(VK_RWIN) & 0x8000) != 0);
            string json = "{\"t\":\"key\",\"id\":" + id.ToString(CultureInfo.InvariantCulture)
                + ",\"key\":" + JStr(key)
                + ",\"mods\":{\"ctrl\":" + (ctrl ? "true" : "false")
                + ",\"alt\":" + (alt ? "true" : "false")
                + ",\"shift\":" + (shift ? "true" : "false")
                + ",\"meta\":" + (meta ? "true" : "false") + "}}";
            ThreadPool.QueueUserWorkItem(delegate { SendRaw(json); });   // never block the LL hook
        }

        static void HandleKeyResult(Dictionary<string, object> map)
        {
            int id = Num(map, "id", -1);
            object cv;
            bool consumed = map.TryGetValue("consumed", out cv) && cv is bool && (bool)cv;
            ushort vk = 0;
            lock (_pendingKeys)
            {
                if (_pendingKeys.TryGetValue(id, out vk)) _pendingKeys.Remove(id);
            }
            if (!consumed && vk != 0) ReinjectChord(vk);
        }

        // The runtime declined the chord: give it back to the app. Only the
        // arrow is injected (marked so the hook passes it); Ctrl+Alt are
        // still physically held by the user, so the app sees the chord.
        static void ReinjectChord(ushort vk)
        {
            var inputs = new INPUT[]
            {
                MarkedKeyInput(vk, false),
                MarkedKeyInput(vk, true),
            };
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        static INPUT MarkedKeyInput(ushort vk, bool upFlag)
        {
            return new INPUT
            {
                type = INPUT_KEYBOARD,
                U = new InputUnion
                {
                    ki = new KEYBDINPUT
                    {
                        wVk = vk,
                        wScan = 0,
                        dwFlags = (upFlag ? KEYEVENTF_KEYUP : 0) | KEYEVENTF_EXTENDEDKEY,   // arrows are extended keys
                        time = 0,
                        dwExtraInfo = INJECT_MARK,
                    },
                },
            };
        }

        // --- Real caret (native IUIAutomationTextPattern2) ---------------
        // The managed UIA client has no TextPattern2, so GetCaretRange goes
        // through the native COM client (same lazy singleton the caret
        // restore uses). Offset = length of the text from document start to
        // the caret - the same EOL dress ValuePattern reads use, so it maps
        // straight onto the mirror string. Fields without TextPattern2 keep
        // the phase-1 caret-at-end model.
        [ComImport, Guid("506a921a-fcc9-409f-b23b-37eb74106872"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IUIAutomationTextPattern2N
        {
            // Base TextPattern slots (IDL order - do not reorder).
            [PreserveSig] int RangeFromPoint(UiaPt pt, out IUIAutomationTextRangeN range);
            [PreserveSig] int RangeFromChild(IntPtr child, out IUIAutomationTextRangeN range);
            [PreserveSig] int GetSelection(out IntPtr ranges);
            [PreserveSig] int GetVisibleRanges(out IntPtr ranges);
            [PreserveSig] int get_DocumentRange(out IUIAutomationTextRangeN range);
            [PreserveSig] int get_SupportedTextSelection(out int sts);
            // TextPattern2 additions.
            [PreserveSig] int RangeFromAnnotation(IntPtr annotation, out IUIAutomationTextRangeN range);
            [PreserveSig] int GetCaretRange(out int isActive, out IUIAutomationTextRangeN range);
        }
        const int UIA_TextPattern2Id_N = 10024;
        const int TU_Character = 0;   // TextUnit_Character

        static int _lastSentCaret = -1;

        static bool TryGetCaretOffset(out int offset)
        {
            offset = -1;
            try
            {
                var uia = NativeUia();
                if (uia == null) return false;
                IUIAutomationElementN el;
                if (uia.GetFocusedElement(out el) != 0 || el == null) return false;
                object po;
                if (el.GetCurrentPattern(UIA_TextPattern2Id_N, out po) != 0 || po == null) return false;
                var tp2 = po as IUIAutomationTextPattern2N;
                if (tp2 == null) return false;
                int active;
                IUIAutomationTextRangeN caret;
                if (tp2.GetCaretRange(out active, out caret) != 0 || caret == null) return false;
                IUIAutomationTextRangeN doc, pre;
                if (tp2.get_DocumentRange(out doc) != 0 || doc == null) return false;
                if (doc.Clone(out pre) != 0 || pre == null) return false;
                if (pre.MoveEndpointByRange(EPT_End, caret, EPT_Start) != 0) return false;
                string t;
                if (pre.GetText(-1, out t) != 0 || t == null) return false;
                offset = t.Length;
                return true;
            }
            catch { return false; }
        }

        // Caret for outbound focus/text messages: the real caret on a
        // cycling UIA field, end-of-text everywhere else (phase-1 model).
        static int CaretOrEnd(string text)
        {
            int len = text == null ? 0 : text.Length;
            if (_attachMode == AttachMode.Uia && _fieldCycling)
            {
                int off;
                if (TryGetCaretOffset(out off) && off >= 0) return Math.Min(off, len);
            }
            return len;
        }

        // Poll-tick caret watch: a caret move WITHOUT a text change becomes
        // a `cursor` event (cursor-navigate mode + post-substitution caret
        // bookkeeping on the daemon side). Skipped while the write bracket
        // is open - mid-substitution caret churn is not user intent.
        static void MaybePollCaret()
        {
            if (!_attached || _attachMode != AttachMode.Uia || !_fieldCycling || _bracketOpen) return;
            int off;
            if (!TryGetCaretOffset(out off) || off < 0) return;
            int max = _lastSentText != null ? _lastSentText.Length : 0;
            if (off > max) off = max;
            if (off == _lastSentCaret) return;
            _lastSentCaret = off;
            SendRaw("{\"t\":\"cursor\",\"cursor\":" + off.ToString(CultureInfo.InvariantCulture) + "}");
        }

        // Apply the daemon's set-cursor. Edit-family HWNDs take EM_SETSEL
        // (message-based, no focus theft); other UIA fields take a native
        // collapsed-range Select at the mapped offset. Best-effort - a
        // wrong caret self-corrects on the next user click/keystroke.
        static void ApplySetCursor(int offset)
        {
            if (offset < 0 || !_attached || _attachMode != AttachMode.Uia) return;
            AutomationElement el = null;
            try { el = AutomationElement.FocusedElement; } catch { }
            if (el == null) return;
            try
            {
                IntPtr hwnd = new IntPtr(el.Current.NativeWindowHandle);
                string cls;
                if (IsEditClassHwnd(hwnd, out cls))
                {
                    IntPtr res;
                    SendMessageTimeoutW(hwnd, EM_SETSEL, new IntPtr(offset), new IntPtr(offset), SMTO_ABORTIFHUNG, 1000, out res);
                    SendMessageTimeoutW(hwnd, EM_SCROLLCARET, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 1000, out res);
                    _lastSentCaret = offset;
                    return;
                }
                if (TryNativeUiaCaretToOffset(offset)) _lastSentCaret = offset;
            }
            catch { }
        }

        static bool TryNativeUiaCaretToOffset(int offset)
        {
            try
            {
                var uia = NativeUia();
                if (uia == null) return false;
                IUIAutomationElementN el;
                if (uia.GetFocusedElement(out el) != 0 || el == null) return false;
                object po;
                if (el.GetCurrentPattern(UIA_TextPatternId_N, out po) != 0 || po == null) return false;
                var tp = po as IUIAutomationTextPatternN;
                if (tp == null) return false;
                IUIAutomationTextRangeN doc, r;
                if (tp.get_DocumentRange(out doc) != 0 || doc == null) return false;
                if (doc.Clone(out r) != 0 || r == null) return false;
                if (r.MoveEndpointByRange(EPT_End, doc, EPT_Start) != 0) return false;   // collapse at doc start
                int units = MapStrToUiaChars(_lastSentText, offset);
                if (units > 0) { int moved; r.Move(TU_Character, units, out moved); }
                return r.Select() == 0;
            }
            catch { return false; }
        }

        // --- Overlay (dim/highlight spans -> screen rects) ---------------
        // The daemon ships char spans (`render` message); the shim resolves
        // them to physical screen rects via the hooked element's managed
        // TextPattern and hands them to OverlayForm (a layered, topmost,
        // click-through window on its own STA thread). Spans are
        // re-resolved on every render push AND every other poll tick, so
        // the paint follows window moves/scrolls at ~300ms worst case.
        static readonly bool _overlayEnabled = Environment.GetEnvironmentVariable("OPENCUES_WIN_OVERLAY") != "0";
        // Set by the UIA change-event handlers (any callback thread); the
        // poll loop consumes it to re-rect immediately on the wake the
        // event itself caused.
        static volatile bool _overlayDirty;
        static OverlayForm _overlay;
        static Thread _overlayThread;
        static readonly object _overlayLock = new object();
        static List<int[]> _dimSpans = new List<int[]>();   // [start,end) into _lastSentText
        static int[] _hlSpan = null;
        static string _overlayStyle = "underline";
        static int _overlayTickFlip;

        static void HandleRenderMsg(Dictionary<string, object> map)
        {
            var dim = new List<int[]>();
            object dv;
            if (map.TryGetValue("dim", out dv))
            {
                var arr = dv as List<object>;
                if (arr != null)
                {
                    foreach (var it in arr)
                    {
                        var pair = it as List<object>;
                        if (pair != null && pair.Count >= 2 && pair[0] is double && pair[1] is double)
                            dim.Add(new int[] { (int)(double)pair[0], (int)(double)pair[1] });
                    }
                }
            }
            int[] hl = null;
            object hv;
            if (map.TryGetValue("hl", out hv))
            {
                var pair = hv as List<object>;
                if (pair != null && pair.Count >= 2 && pair[0] is double && pair[1] is double)
                    hl = new int[] { (int)(double)pair[0], (int)(double)pair[1] };
            }
            string style = Str(map, "style");
            if (!string.IsNullOrEmpty(style)) _overlayStyle = style;
            _dimSpans = dim;
            _hlSpan = hl;
            UpdateOverlay();
        }

        static void ClearOverlaySpans()
        {
            _dimSpans = new List<int[]>();
            _hlSpan = null;
            var ov = _overlay;
            if (ov != null) ov.Push(null, _overlayStyle);
        }

        static void UpdateOverlay()
        {
            if (!_overlayEnabled) return;
            bool have = _attached && _attachMode == AttachMode.Uia && _fieldCycling
                && (_dimSpans.Count > 0 || _hlSpan != null);
            if (!have)
            {
                var ov = _overlay;
                if (ov != null) ov.Push(null, _overlayStyle);
                _lastFirstX = float.MinValue;
                _lastFirstY = float.MinValue;
                return;
            }
            EnsureOverlay();
            var form = _overlay;
            if (form == null) return;
            var rects = ComputeOverlayRects();
            // Remember where the first rect landed - the per-tick movement
            // probe compares against this to catch scroll/drag/zoom (which
            // fire no UIA event we subscribe to).
            if (rects.Count > 0) { _lastFirstX = rects[0].X; _lastFirstY = rects[0].Y; }
            else { _lastFirstX = float.MinValue; _lastFirstY = float.MinValue; }
            form.Push(rects, _overlayStyle);
        }

        // Event-driven re-rect (anti-flash step 2, 2026-07-20). Three
        // triggers, fastest first:
        //   1. `_overlayDirty` - the UIA value/text change events already
        //      wake the poll loop; they now also mark the overlay dirty, so
        //      a typing-induced reflow re-rects on the SAME wake instead of
        //      waiting out the tick cadence.
        //   2. A cheap per-tick probe of the FIRST span's rect - scrolling,
        //      window drags and zoom move rects without any subscribed
        //      event; one UIA range call per tick catches them within a
        //      single poll iteration (<=150ms) instead of ~300ms.
        //   3. The every-other-tick baseline refresh, kept as the converging
        //      fallback for anything the above miss.
        static void MaybeRefreshOverlay()
        {
            if (!_overlayEnabled || _overlay == null) return;
            if (_dimSpans.Count == 0 && _hlSpan == null) return;
            bool force = _overlayDirty;
            _overlayDirty = false;
            if (!force) force = OverlayRectsMoved();
            if (!force && (++_overlayTickFlip & 1) != 0) return;   // baseline cadence
            UpdateOverlay();
        }

        static float _lastFirstX = float.MinValue;
        static float _lastFirstY = float.MinValue;

        // Did the first span's on-screen rect move since the last push?
        // One TextPattern range resolve - cheap enough to run every tick.
        static bool OverlayRectsMoved()
        {
            if (_lastFirstX == float.MinValue) return false;
            try
            {
                var el = _hookedEl;
                var text = _lastSentText;
                if (el == null || text == null) return false;
                int[] span = _dimSpans.Count > 0 ? _dimSpans[0] : _hlSpan;
                if (span == null) return false;
                object tpo;
                if (!el.TryGetCurrentPattern(TextPattern.Pattern, out tpo)) return false;
                var probe = new List<OverlaySpanRect>();
                AddSpanRects(((TextPattern)tpo).DocumentRange, text, span[0], span[1], false, -1, probe);
                if (probe.Count == 0) return false;
                return Math.Abs(probe[0].X - _lastFirstX) > 0.5f || Math.Abs(probe[0].Y - _lastFirstY) > 0.5f;
            }
            catch { return false; }
        }

        static List<OverlaySpanRect> ComputeOverlayRects()
        {
            var list = new List<OverlaySpanRect>();
            var el = _hookedEl;
            var text = _lastSentText;
            if (el == null || text == null) return list;
            object tpo;
            try { if (!el.TryGetCurrentPattern(TextPattern.Pattern, out tpo)) return list; }
            catch { return list; }
            TextPatternRange doc;
            try { doc = ((TextPattern)tpo).DocumentRange; }
            catch { return list; }
            // Caret position marks spans HOT: the capture style re-captures
            // hot spans on every refresh tick so the caret blink and live
            // edits under the patch stay visible ("re-apply when it is
            // moving or in focus" - 2026-07-20 feedback).
            int caret = -1;
            if (_fieldCycling) { int off; if (TryGetCaretOffset(out off)) caret = off; }
            foreach (var span in _dimSpans) AddSpanRects(doc, text, span[0], span[1], false, caret, list);
            if (_hlSpan != null) AddSpanRects(doc, text, _hlSpan[0], _hlSpan[1], true, caret, list);
            return list;
        }

        static void AddSpanRects(TextPatternRange doc, string text, int s, int e, bool active, int caret, List<OverlaySpanRect> list)
        {
            try
            {
                if (s < 0 || e <= s || e > text.Length) return;
                var r = doc.Clone();
                r.MoveEndpointByRange(TextPatternRangeEndpoint.End, doc, TextPatternRangeEndpoint.Start);
                int su = MapStrToUiaChars(text, s);
                int eu = MapStrToUiaChars(text, e);
                if (eu > 0) r.MoveEndpointByUnit(TextPatternRangeEndpoint.End, TextUnit.Character, eu);
                if (su > 0) r.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, su);
                var rects = r.GetBoundingRectangles();
                if (rects == null) return;
                string word = text.Substring(s, e - s);
                // STRICTLY inside: a caret parked at the span edge (the
                // caret-at-end-of-buffer resting state, with a span that
                // covers the whole buffer) must NOT count as hot - it made
                // every substitution span permanently hot, re-capturing at
                // 3Hz and compounding any self-capture race into the
                // fade-to-nothing spiral (2026-07-20 "no grey" report).
                bool hot = caret > s && caret < e;
                foreach (System.Windows.Rect rc in rects)
                {
                    if (rc.IsEmpty || rc.Width <= 0 || rc.Height <= 0) continue;
                    list.Add(new OverlaySpanRect
                    {
                        X = (float)rc.X,
                        Y = (float)rc.Y,
                        W = (float)rc.Width,
                        H = (float)rc.Height,
                        Active = active,
                        Word = word,
                        Hot = hot,
                    });
                }
            }
            catch { /* span resolve is best-effort; a missing rect = no paint */ }
        }

        static void EnsureOverlay()
        {
            lock (_overlayLock)
            {
                if (_overlay != null || _overlayThread != null) return;
                var ready = new ManualResetEvent(false);
                _overlayThread = new Thread(delegate ()
                {
                    try
                    {
                        var form = new OverlayForm();
                        var h = form.Handle;   // force handle creation before Push can race
                        _overlay = form;
                        ready.Set();
                        SWF.Application.Run(form);
                    }
                    catch (Exception ex)
                    {
                        Log("warn", "overlay unavailable: " + ex.Message);
                        _overlay = null;
                        ready.Set();
                    }
                });
                _overlayThread.SetApartmentState(ApartmentState.STA);
                _overlayThread.IsBackground = true;
                _overlayThread.Start();
                ready.WaitOne(3000);
            }
        }

        static void StopOverlay()
        {
            var ov = _overlay;
            _overlay = null;
            if (ov == null) return;
            try { ov.BeginInvoke((Action)(delegate { try { ov.Close(); } catch { } SWF.Application.ExitThread(); })); }
            catch { }
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
        // Overlay diagnostics funnel - OverlayForm lives outside this class
        // but its failures must land in the same daemon log (silent paint
        // problems are undiagnosable from WSL otherwise).
        internal static void OverlayLog(string msg) { Log("debug", "[overlay] " + msg); }

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

    // --- Phase-2 overlay window --------------------------------------------
    // One rect the overlay paints: physical screen coordinates (the process
    // is Per-Monitor-V2 DPI aware, so WinForms coords are physical too),
    // plus the word text (part of the capture-cache key) and whether this is
    // the actively-cycling span.
    internal class OverlaySpanRect
    {
        public float X, Y, W, H;
        public bool Active;
        public string Word;
        // The caret currently sits inside this span. The capture style
        // treats hot spans as always-stale (re-captured every refresh
        // tick, ~300ms) so the caret blink and live edits under the
        // patch stay visible; cold spans repaint from cache untouched.
        public bool Hot;
    }

    // A full-virtual-screen, topmost, LAYERED + TRANSPARENT (click-through)
    // + NOACTIVATE window. Everything painted in the key colour is fully
    // transparent; everything else is the overlay ink. Dim looks,
    // switchable per render push (daemon env OPENCUES_WIN_OVERLAY_STYLE):
    //   underline - thin gray line under the word (active: thicker, blue)
    //   wash      - whole-window alpha ~43% -> translucent tint over the word
    //   capture   - screen-capture the word rect and redraw the APP'S OWN
    //               glyph pixels dimmed: every pixel is collapsed to its
    //               luminance and pulled toward the rect's corner-sampled
    //               background (active span pulls toward the accent
    //               instead). True terminal gray - no fonts, no guessing.
    //               CopyFromScreen would capture our OWN ink, so captures
    //               happen behind a one-frame self-clear (hide ink ->
    //               wait one composition -> capture) and land in a
    //               per-span bitmap cache; steady state repaints from
    //               cache with zero captures. Scroll/move invalidates the
    //               cache -> the marks blink for a frame while they
    //               re-capture (known v1 cost).
    internal class OverlayForm : SWF.Form
    {
        const int WS_EX_LAYERED = 0x80000;
        const int WS_EX_TRANSPARENT = 0x20;
        const int WS_EX_TOOLWINDOW = 0x80;
        const int WS_EX_NOACTIVATE = 0x8000000;
        const uint LWA_COLORKEY = 1;
        const uint LWA_ALPHA = 2;
        const uint WDA_EXCLUDEFROMCAPTURE = 0x11;   // Win10 2004+
        [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint key, byte alpha, uint flags);
        [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);

        static readonly SD.Color KeyColor = SD.Color.Magenta;
        static readonly SD.Color DimColor = SD.Color.FromArgb(150, 150, 150);
        static readonly SD.Color ActiveColor = SD.Color.FromArgb(30, 110, 220);

        string _style = "underline";
        List<OverlaySpanRect> _rects = new List<OverlaySpanRect>();
        // capture-style bitmap cache: span key -> dimmed screen pixels.
        readonly Dictionary<string, SD.Bitmap> _capCache = new Dictionary<string, SD.Bitmap>();
        // This window is excluded from screen capture (WDA_EXCLUDEFROMCAPTURE
        // succeeded): CopyFromScreen never sees our own ink, so captures need
        // no hide-and-wait dance and CANNOT self-capture (the re-dim
        // fade-to-nothing spiral is structurally impossible). False on
        // pre-2004 Windows 10 - the one-frame self-clear fallback runs there.
        bool _captureExcluded;

        public OverlayForm()
        {
            FormBorderStyle = SWF.FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = SWF.FormStartPosition.Manual;
            TopMost = true;
            Bounds = SWF.SystemInformation.VirtualScreen;
            BackColor = KeyColor;
            SetStyle(SWF.ControlStyles.AllPaintingInWmPaint | SWF.ControlStyles.UserPaint
                | SWF.ControlStyles.OptimizedDoubleBuffer, true);
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override SWF.CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyLayered();
            try { _captureExcluded = SetWindowDisplayAffinity(Handle, WDA_EXCLUDEFROMCAPTURE); }
            catch { _captureExcluded = false; }
            WindowsShim.OverlayLog("created (capture-excluded=" + _captureExcluded + ")");
        }

        void ApplyLayered()
        {
            // COLORREF is 0x00BBGGRR. Wash rides the whole-window alpha (the
            // keyed pixels stay fully transparent either way); the other two
            // styles paint at full opacity.
            byte alpha = _style == "wash" ? (byte)110 : (byte)255;
            uint key = (uint)(KeyColor.R | (KeyColor.G << 8) | (KeyColor.B << 16));
            try { SetLayeredWindowAttributes(Handle, key, alpha, LWA_COLORKEY | LWA_ALPHA); } catch { }
        }

        // Called from the shim's poll thread. Null/empty rects hide the ink.
        public void Push(List<OverlaySpanRect> rects, string style)
        {
            try
            {
                BeginInvoke((Action)(delegate
                {
                    bool styleChanged = style != null && style != _style;
                    if (style != null) _style = style;
                    var next = rects ?? new List<OverlaySpanRect>();
                    if (styleChanged) { ApplyLayered(); ClearCapCache(); }
                    if (_style == "capture") EnsureCaptures(next);
                    else if (_capCache.Count > 0) ClearCapCache();
                    _rects = next;
                    Invalidate();
                }));
            }
            catch { /* form closing / handle gone - overlay is cosmetic */ }
        }

        // ---- capture style ------------------------------------------------
        static string CapKey(OverlaySpanRect r)
        {
            return ((int)r.X) + "," + ((int)r.Y) + "," + ((int)r.W) + "," + ((int)r.H)
                + "," + (r.Active ? "a" : "d") + "," + (r.Word ?? "");
        }

        void ClearCapCache()
        {
            foreach (var b in _capCache.Values) { try { b.Dispose(); } catch { } }
            _capCache.Clear();
        }

        // Capture any span rects missing from the cache. CopyFromScreen sees
        // the composited desktop INCLUDING this window, so before capturing
        // we hide all ink for one composition frame (paint nothing, flush,
        // give DWM a beat) - then the captured pixels are the app's own.
        // Runs on the UI thread inside Push; the ~35ms pause only happens on
        // cache misses (new/changed spans), never in steady state.
        void EnsureCaptures(List<OverlaySpanRect> next)
        {
            var wanted = new HashSet<string>();
            var missing = new List<OverlaySpanRect>();
            foreach (var r in next)
            {
                string k = CapKey(r);
                wanted.Add(k);
                // Hot span (caret inside): force a fresh capture every
                // refresh so the caret blink / live edits show through.
                if (r.Hot && _capCache.ContainsKey(k))
                {
                    try { _capCache[k].Dispose(); } catch { }
                    _capCache.Remove(k);
                }
                if (!_capCache.ContainsKey(k) && r.W >= 2 && r.H >= 2) missing.Add(r);
            }
            // Drop cache entries for spans that no longer exist.
            var stale = new List<string>();
            foreach (var k in _capCache.Keys) if (!wanted.Contains(k)) stale.Add(k);
            foreach (var k in stale) { try { _capCache[k].Dispose(); } catch { } _capCache.Remove(k); }

            if (missing.Count == 0) return;
            List<OverlaySpanRect> save = null;
            if (!_captureExcluded)
            {
                // Fallback (pre-2004 Win10): CopyFromScreen WOULD see our own
                // ink, so hide it for one composited frame first. Racy - if
                // DWM hasn't flushed the clear, we capture our own patch and
                // re-dim it (compounding toward invisibility) - which is why
                // the capture-exclusion path above is strongly preferred.
                save = _rects;
                _rects = new List<OverlaySpanRect>();
                Invalidate();
                Update();
                Thread.Sleep(35);
            }
            int ok = 0, failed = 0;
            bool anyCold = false;
            foreach (var m in missing) if (!m.Hot) { anyCold = true; break; }
            foreach (var r in missing)
            {
                try
                {
                    var bmp = new SD.Bitmap(Math.Max(2, (int)Math.Ceiling(r.W)), Math.Max(2, (int)Math.Ceiling(r.H)),
                        SD.Imaging.PixelFormat.Format32bppArgb);
                    using (var g = SD.Graphics.FromImage(bmp))
                        g.CopyFromScreen((int)r.X, (int)r.Y, 0, 0, new SD.Size(bmp.Width, bmp.Height));
                    DimBitmap(bmp, r.Active);
                    if (_capCache.Count > 64) ClearCapCache();   // runaway backstop
                    _capCache[CapKey(r)] = bmp;
                    ok++;
                }
                catch (Exception ex)
                {
                    failed++;
                    if (failed == 1) WindowsShim.OverlayLog("capture failed: " + ex.Message);
                }
            }
            if (save != null) _rects = save;
            // Hot-only batches recapture at ~3Hz while the caret sits in a
            // word - logging those would flood the daemon log. Cold batches
            // and failures are the diagnostic signal.
            if (failed > 0 || (ok > 0 && anyCold))
                WindowsShim.OverlayLog("captured " + ok + " span(s)" + (failed > 0 ? (", " + failed + " failed") : "")
                    + " (excl=" + _captureExcluded + ")");
        }

        // Collapse every pixel to its luminance, then pull it toward the
        // background (dim) or the accent (active). Background = average of
        // the four corner pixels - corners of a word rect are almost always
        // the field's background, so glyphs fade INTO their own field on
        // both light and dark themes. Managed byte loop (no unsafe - this
        // must compile under Add-Type); word rects are tiny.
        static void DimBitmap(SD.Bitmap bmp, bool active)
        {
            var rect = new SD.Rectangle(0, 0, bmp.Width, bmp.Height);
            var data = bmp.LockBits(rect, SD.Imaging.ImageLockMode.ReadWrite, SD.Imaging.PixelFormat.Format32bppArgb);
            try
            {
                int n = Math.Abs(data.Stride) * bmp.Height;
                byte[] px = new byte[n];
                Marshal.Copy(data.Scan0, px, 0, n);
                int stride = data.Stride;
                // Corner-average background estimate (BGRA layout).
                int[] cx = { 0, bmp.Width - 1, 0, bmp.Width - 1 };
                int[] cy = { 0, 0, bmp.Height - 1, bmp.Height - 1 };
                int bgB = 0, bgG = 0, bgR = 0;
                for (int i = 0; i < 4; i++)
                {
                    int o = cy[i] * stride + cx[i] * 4;
                    bgB += px[o]; bgG += px[o + 1]; bgR += px[o + 2];
                }
                bgB /= 4; bgG /= 4; bgR /= 4;
                int tB = active ? ActiveColor.B : bgB;
                int tG = active ? ActiveColor.G : bgG;
                int tR = active ? ActiveColor.R : bgR;
                const int MIX = 45;   // % pulled toward the target
                for (int y = 0; y < bmp.Height; y++)
                {
                    int row = y * stride;
                    for (int x = 0; x < bmp.Width; x++)
                    {
                        int o = row + x * 4;
                        int lum = (px[o + 2] * 299 + px[o + 1] * 587 + px[o] * 114) / 1000;
                        px[o] = (byte)(lum + (tB - lum) * MIX / 100);
                        px[o + 1] = (byte)(lum + (tG - lum) * MIX / 100);
                        px[o + 2] = (byte)(lum + (tR - lum) * MIX / 100);
                        px[o + 3] = 255;
                    }
                }
                Marshal.Copy(px, 0, data.Scan0, n);
            }
            finally { bmp.UnlockBits(data); }
        }

        static bool _paintErrorLogged;
        protected override void OnPaint(SWF.PaintEventArgs e)
        {
            try { PaintCore(e); }
            catch (Exception ex)
            {
                // A paint exception must never kill the overlay thread
                // silently - that reads as "marks just stopped appearing".
                if (!_paintErrorLogged) { _paintErrorLogged = true; WindowsShim.OverlayLog("paint failed: " + ex.Message); }
            }
        }

        void PaintCore(SWF.PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(KeyColor);
            var rects = _rects;
            if (rects == null || rects.Count == 0) return;
            foreach (var r in rects)
            {
                float x = r.X - Bounds.X;   // screen -> client (virtual-screen origin can be negative)
                float y = r.Y - Bounds.Y;
                switch (_style)
                {
                    case "wash":
                        {
                            using (var b = new SD.SolidBrush(r.Active ? ActiveColor : DimColor))
                                g.FillRectangle(b, x, y, r.W, r.H);
                            break;
                        }
                    case "capture":
                        {
                            SD.Bitmap bmp;
                            if (_capCache.TryGetValue(CapKey(r), out bmp))
                            {
                                g.DrawImageUnscaled(bmp, (int)x, (int)y);
                            }
                            else
                            {
                                // capture failed/pending - underline fallback
                                using (var p = new SD.Pen(r.Active ? ActiveColor : DimColor, 2f))
                                    g.DrawLine(p, x, y + r.H - 1f, x + r.W, y + r.H - 1f);
                            }
                            break;
                        }
                    default:   // underline
                        {
                            float th = r.Active ? 3f : 2f;
                            using (var p = new SD.Pen(r.Active ? ActiveColor : DimColor, th))
                                g.DrawLine(p, x, y + r.H - 1f, x + r.W, y + r.H - 1f);
                            break;
                        }
                }
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) ClearCapCache();
            base.Dispose(disposing);
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
