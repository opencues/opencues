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
using System.Windows.Automation.Text;   // TextPatternRange - caret restore on Chromium-UIA fields
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
        static string _lastApp = null;        // process name of the attached field's app
        static bool _attached = false;

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
            if (s == null || (s.IndexOf('\r') < 0)) return s;
            return s.Replace("\r\n", "\n").Replace('\r', '\n');
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

        // --- TSF flash-free write transport (opt-in, M5) ----------------
        // The OpenCues TSF TIP (native/tsf/) loads IN-PROCESS into the focused
        // app and serves a per-PID command pipe \\.\pipe\opencues-tsf-<pid>.
        // WSL2 can't open a Windows named pipe, so the daemon can't drive it
        // directly - the shim (this process, on Windows) is the pipe client and
        // the daemon owns the opt-in policy (advertised in `welcome`, or the
        // OPENCUES_TSF=0 kill switch). TSF engages AUTOMATICALLY whenever a
        // live TIP answers for the focused app's PID - installing the TIP is
        // the deliberate, UAC-gated opt-in, so a second flag would be redundant.
        // The REAL substitution is then written through ITfRange::SetText -
        // flash-free, no Slate ghost, no select-all churn - instead of the
        // UIA/paste path. Animation micro-frames stay on the typed path (already
        // flash-free; per-frame pipe round-trips aren't worth it). ANY pipe
        // failure falls straight through to the legacy path, so nothing
        // regresses when the TIP isn't installed. Kill switch: OPENCUES_TSF=0
        // (here or on the daemon -> welcome tsf:false) forces the legacy path.
        static bool _tsfDisabled = false;     // kill switch (env OPENCUES_TSF=0 OR welcome tsf:false)
        static int _focusedPid = 0;           // PID of the focused field's process
        static int _tsfProbedPid = 0;         // PID last probed (cache key; reset on new field)
        static bool _tsfProbedAvail = false;  // was a live TIP present for it?

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
            if (Environment.GetEnvironmentVariable("OPENCUES_TSF") == "0") _tsfDisabled = true;
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
                _valueChangedHandler = (s, e) => { try { _wake.Set(); } catch { } };
                Automation.AddAutomationPropertyChangedEventHandler(el, TreeScope.Element, _valueChangedHandler, ValuePattern.ValueProperty);
            }
            catch { _valueChangedHandler = null; }
            try
            {
                _textChangedHandler = (s, e) => { try { _wake.Set(); } catch { } };
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
                            // Daemon kill switch for the TSF flash-free path:
                            // welcome tsf:false disables it (default is true /
                            // auto). Either side may force it off.
                            object tv;
                            if (map.TryGetValue("tsf", out tv) && tv is bool && !(bool)tv) _tsfDisabled = true;
                            StatusLine = "connected";
                            Log("info", "daemon ready (host=" + Str(map, "host") + " v" + Str(map, "hostVersion")
                                + " config=" + ConfigPathWin + " tsf=" + (_tsfDisabled ? "off" : "auto") + ")");
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

            if (el == null) { _focusedPid = 0; LeaveAttached(null); return; }

            int elId;
            string app;
            try
            {
                elId = el.GetRuntimeId() != null ? RuntimeIdHash(el.GetRuntimeId()) : el.GetHashCode();
                app = ProcessName(el);
                try { _focusedPid = el.Current.ProcessId; } catch { _focusedPid = 0; }
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
            _lastApp = app;
            if (elId != _lastElementId)
            {
                _lastElementId = elId;
                _attachMode = mode;
                _lastSentText = readText;
                _expectedEcho = null;
                _recentWrites.Clear();
                _bracketOpen = false;
                _attached = true;
                _tsfProbedPid = 0;   // re-probe TIP availability for this new field
                bool tsf = !_tsfDisabled && TsfAvailable(_focusedPid);
                StatusLine = "on: " + (app ?? "text field") + (tsf ? " (TSF)" : "");
                Log("info", "attached: " + (app ?? "text field") + " ("
                    + (readText == null ? 0 : readText.Length) + " chars, "
                    + (mode == AttachMode.Msaa ? "MSAA" : "UIA") + (tsf ? ", TSF" : "") + ")");
                SendRaw("{\"t\":\"focus\",\"app\":" + JStr(app) + ",\"text\":" + JStr(readText)
                    + ",\"cursor\":" + (readText == null ? 0 : readText.Length).ToString(CultureInfo.InvariantCulture)
                    + ",\"tsf\":" + (tsf ? "true" : "false") + "}");
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
                + ",\"cursor\":" + cur.Length.ToString(CultureInfo.InvariantCulture) + "}");
        }

        static void LeaveAttached(string app)
        {
            if (!_attached) { _lastElementId = int.MinValue; if (_enabled) StatusLine = "idle"; return; }
            _attached = false;
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

        // WordPad's RICHEDIT50W (via the MSAA→UIA proxy) includes RichEdit's
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

        static string NormalizeNewlinesForApp(string text)
        {
            if (text == null || _lastApp == null || !ParagraphBreakApps.Contains(_lastApp)) return text;
            if (text.IndexOf('\n') < 0 && text.IndexOf('\r') < 0) return text;
            string norm = text.Replace("\r\n", "\n").Replace('\r', '\n');
            while (norm.Contains("\n\n")) norm = norm.Replace("\n\n", "\n");
            if (norm != text)
                Log("debug", "paragraph-app newline collapse for " + _lastApp + " (" + text.Length + " -> " + norm.Length + " chars)");
            return norm;
        }

        // --- TSF pipe client (M5) ---------------------------------------
        // Connect to the focused app's in-proc TIP, send one framed command,
        // read the reply. Returns null on any failure (no TIP for this PID,
        // pipe busy, timeout) so the caller falls back to the legacy path.
        static string TsfCommand(int pid, string frame, int connectMs)
        {
            if (pid <= 0) return null;
            try
            {
                using (var pipe = new System.IO.Pipes.NamedPipeClientStream(
                           ".", "opencues-tsf-" + pid, System.IO.Pipes.PipeDirection.InOut))
                {
                    pipe.Connect(connectMs);
                    byte[] outb = Encoding.UTF8.GetBytes(frame);
                    pipe.Write(outb, 0, outb.Length);
                    pipe.Flush();
                    byte[] buf = new byte[70000];
                    int n = pipe.Read(buf, 0, buf.Length);
                    return n > 0 ? Encoding.UTF8.GetString(buf, 0, n) : "";
                }
            }
            catch { return null; }
        }

        // Is a live OpenCues TIP present for this app? Cheap GETCARET probe,
        // cached per focused field (reset in StreamAttachment on element change)
        // so a substitution stream costs one probe, not one per frame.
        static bool TsfAvailable(int pid)
        {
            if (pid <= 0) return false;
            if (pid == _tsfProbedPid) return _tsfProbedAvail;
            _tsfProbedPid = pid;
            _tsfProbedAvail = false;
            // O(1) existence check FIRST. NamedPipeClientStream.Connect polls
            // for the full timeout on a non-existent pipe (a per-focus stall
            // for the common no-TIP case); File.Exists on \\.\pipe\ returns
            // instantly. Only round-trip when the pipe is actually present.
            if (System.IO.File.Exists(@"\\.\pipe\opencues-tsf-" + pid))
            {
                string r = TsfCommand(pid, "GETCARET\n", 150);
                _tsfProbedAvail = (r != null && r.StartsWith("OK", StringComparison.Ordinal));
            }
            return _tsfProbedAvail;
        }

        // Replace the focused field's whole value flash-free via the TIP's
        // ITfRange::SetText. True only on a confirmed OK reply.
        static bool TsfSetText(int pid, string text)
        {
            string r = TsfCommand(pid, "SETTEXT\n" + text, 500);
            return (r != null && r.StartsWith("OK", StringComparison.Ordinal));
        }

        static void ApplySetText(string text)
        {
            if (text == null) return;
            text = NormalizeNewlinesForApp(text);

            // TSF flash-free path (opt-in): route the REAL substitution through
            // the in-proc TIP when one is live for the focused app. Animation
            // frames (small tail swaps) are left to the typed micro-edit path
            // below - they don't flash and per-frame pipe round-trips aren't
            // worth it. On any pipe failure this is a no-op and we fall straight
            // through to the legacy UIA/MSAA paths - nothing regresses.
            if (!_tsfDisabled && _focusedPid > 0
                && !LooksLikeAnimationFrame(_lastSentText, text)
                && TsfAvailable(_focusedPid)
                && TsfSetText(_focusedPid, text))
            {
                NoteSelfWrite(text);
                Log("debug", "applied substitution (" + text.Length + " chars, TSF flash-free)");
                return;
            }

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
                    // the caret ~13x/sec — the visible bouncing. Type the
                    // spinner frames through the real input pipeline instead
                    // (Discord's model): relative typed frames anchored by the
                    // absolute SetValue FINAL below, and editor-safe by
                    // construction (input events, not DOM mutation — see the
                    // Slate-ghost finding). Must run BEFORE NoteSelfWrite: the
                    // micro-edit diffs against _lastSentText. Edit-family HWNDs
                    // (Notepad/WordPad) skip this — their convergent EM path is
                    // strictly better (positioned writes, no caret reset at all).
                    if (!isEditHwnd && TryTypeMicroEdit(text)) return;
                    NoteSelfWrite(text);
                    // Convergent EM path (Edit/RichEdit HWNDs): absolute writes
                    // computed against the real buffer (no drift) + native undo.
                    if (isEditHwnd && TryEmConvergentWrite(el, (ValuePattern)vp, text, streamStart)) return;
                    // Non-Edit UIA composer (Slack etc.) or an EM verify-fail →
                    // absolute SetValue. SetValue resets the caret to the START,
                    // so skip the restore on animation frames (same-length 1-2
                    // char swap) and only restore on the real substitution — no
                    // per-frame caret churn.
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
        // or in length; even a rare same-length ≤2-char substitute only leaves
        // the caret at the field start for one write — cosmetic, self-corrects).
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
        // highlight only — the text keeps painting live, but our transient
        // EM_SETSEL never flashes blue. RichEdit-only (WordPad RICHEDIT50W /
        // Notepad RichEditD2DPT); a harmless no-op on classic "Edit". Toggled
        // around each write (can't stay on, or the user's own selections would
        // be invisible), but with no repaint churn — lighter than WM_SETREDRAW.
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
                // Slack — probed 2026-07-10). Silent — no key synthesis, no
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

        // ── Native IUIAutomation (COM) — OBSERVATION ONLY ─────────────────
        // Chromium/Electron serves its modern UIA provider (TextPattern with a
        // working collapsed-range Select(), i.e. real caret positioning) ONLY
        // to a native IUIAutomation client — what Narrator uses. The managed
        // System.Windows.Automation client used everywhere else in this shim
        // never sees it (Slack: TextPattern False managed / True native —
        // probed 2026-07-10 with uia-native-drive-probe.ps1).
        //
        // HARD RULE: this surface is for READS and SELECTION/CARET only —
        // selection ops (collapsed caret moves, select-all) sync into the
        // editor's model and are safe. CONTENT mutation is banned: writing
        // through it (ValuePattern.SetValue) DESYNCED Discord's Slate editor —
        // ghost text the user cannot delete, broken input until Ctrl+R. See
        // IMPLEMENTATION.md §5 "the Slate ghost". Do not add a content write.
        //
        // The client is created LAZILY on the first non-Edit caret restore
        // (i.e. only when a Slack-class composer is actually being written),
        // so sessions that never touch such a composer never flip Chromium
        // apps into UIA mode. Interfaces are PARTIAL vtables — methods are
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
        // the provider doesn't serve the surface — the caller's ladder
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
        // This is a selection op — the safe half of native UIA on Slate (the
        // ghost came from content mutation). Returns false -> caller falls
        // back to the legacy gap-timed sequence.
        // Logged once per session: WHY the verified select-all path declined,
        // so a fallback-to-legacy-flash is diagnosable from the log without a
        // debug build. (It failed silently on Discord on first ship — never
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
        //   * MSAA/Electron (Discord)  — below the deferred Ctrl+A+paste tier
        //   * non-Edit UIA  (Slack)    — below the whole-value SetValue final
        // Only for edits small enough to be indistinguishable from a human
        // typing; goes through the real input pipeline (SendInput), so it is
        // editor-framework-safe (Slate/Quill process it as genuine input) and
        // never resets the caret. Relative — acceptable ONLY because the final
        // write on both paths is an absolute anchor (paste / SetValue) that
        // wipes any frame drift. NOT used on Edit-family HWNDs
        // (Notepad/WordPad): their convergent EM path is positioned AND
        // absolute, strictly better (the 63be937f revert is the history).
        // Assumes the caret sits at the end of the field (phase-1 cursor
        // model, and the state every prior write path leaves behind).
        const int MSAA_TYPE_MAX = 6;
        // Kill switch: OPENCUES_TYPE_ANIMATE=0 (legacy OPENCUES_MSAA_ANIMATE=0
        // still honoured) → animation falls back to deferred-paste / SetValue.
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
        // CEILING = 40, and this is EMPIRICAL — do not raise it casually: a
        // 2026-07-10 live test at 600 sent a 354-backspace burst into
        // Discord/Slate and it failed outright ("doesn't work at all" —
        // dropped/coalesced under load, mangled result), while the small
        // bursts this path has always used (<=40, and the 1-2-char animation
        // frames) are reliable. Large rewrites take the select-all path and
        // pay one highlight flash — on Slate that is the floor, since every
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
        static void PasteReplace(string text, string oldText)
        {
            string saved = null;
            try { saved = GetClipboardText(); } catch { }

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
                // from the provider, so we KNOW it is committed before Ctrl+V —
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
                    // guaranteed-empty field CANNOT append old content — the
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
            // Electron reads the clipboard ASYNCHRONOUSLY after Ctrl+V; 300ms
            // clears that read before we restore the user's previous clipboard.
            Thread.Sleep(300);
            if (saved != null) { try { SetClipboardText(saved); } catch { } }
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

        // ── The convergent write surface (Edit/RichEdit HWNDs) ──────────────
        // Every write is ABSOLUTE (select-all → EM_REPLACESEL of the whole
        // value) and computed against the buffer's ACTUAL content (read back
        // each call), so nothing drifts — the failure mode of the relative
        // Backspace path (blind delete counts against an optimistic model →
        // overshoot / double-delete / stray dot on a laggy buffer) cannot
        // happen here. EM_REPLACESEL also flows through the control's NATIVE
        // undo, so we keep Ctrl+Z:
        //   • animation frames  → fUndo=FALSE  (cosmetic, no undo record)
        //   • final result      → reset to baseline (fUndo=FALSE, wipes the
        //     animation) then write undoably (fUndo=TRUE) = ONE undo unit, so
        //     one Ctrl+Z restores the pre-command text.
        // Read-back verify (EOL-normalised); any mismatch (a control whose EM
        // index model diverges from the UIA string) returns false and the
        // caller repairs via absolute SetValue — worst case is exactly the
        // prior robust-but-no-undo behaviour. Message-based
        // (SendMessageTimeout ABORTIFHUNG): no focus theft, can't wedge.
        static bool TryEmConvergentWrite(AutomationElement el, ValuePattern vp, string text, bool streamStart)
        {
            try
            {
                string className;
                IntPtr hwnd = new IntPtr(el.Current.NativeWindowHandle);
                if (!IsEditClassHwnd(hwnd, out className)) return false;   // non-Edit → SetValue

                string cur;
                try { cur = StripPhantomTrailingSeparator(el, vp.Current.Value ?? ""); }
                catch { return false; }                                    // can't read reality → SetValue
                if (streamStart) _emUndoBaseline = cur;                     // the `_` command, pre-animation
                if (cur == text) return true;                              // already there

                IntPtr res;
                if (IsSmallDelta(cur, text))
                {
                    // Animation frame: absolute whole-value replace with the
                    // SELECTION HIGHLIGHT hidden so our transient EM_SETSEL never
                    // flashes blue. Absolute (0,-1) → no drift, no index math;
                    // fUndo=FALSE keeps it out of undo.
                    SendMessageTimeoutW(hwnd, EM_HIDESELECTION, new IntPtr(1), IntPtr.Zero, SMTO_ABORTIFHUNG, 1000, out res);
                    try
                    {
                        SendMessageTimeoutW(hwnd, EM_SETSEL, IntPtr.Zero, new IntPtr(-1), SMTO_ABORTIFHUNG, 1500, out res);
                        SendMessageTimeoutText(hwnd, EM_REPLACESEL, IntPtr.Zero /* fUndo=FALSE */, text, SMTO_ABORTIFHUNG, 1500, out res);
                    }
                    finally
                    {
                        SendMessageTimeoutW(hwnd, EM_HIDESELECTION, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 1000, out res);
                    }
                    return true;   // frame is cosmetic; the next write self-corrects
                }

                // Final substitution: a large whole-buffer change. Do it as an
                // absolute select-all replace (skew-immune — only 0/-1), with the
                // selection highlight hidden so it never flashes blue. Baseline-
                // reset (fUndo=FALSE) then result (fUndo=TRUE) = ONE undo unit →
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
                    SendMessageTimeoutText(hwnd, EM_REPLACESEL, new IntPtr(1) /* fUndo=TRUE */, text, SMTO_ABORTIFHUNG, 1500, out res);
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
