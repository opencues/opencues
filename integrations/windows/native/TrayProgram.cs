// OpenCues tray - compiled .NET product shell.
//
// This is the "native window" version chosen for the productized Windows
// host: a WinForms tray app that (1) hosts the UIA shim in-process,
// (2) supervises the Node daemon, and (3) opens Settings in an EMBEDDED
// WebView2 window pointed at the daemon's config URL - the SAME popup
// component the chrome extension uses, served by the daemon over
// localhost. No browser tab; no bespoke settings UI.
//
// Build (needs the .NET SDK w/ Windows Desktop workload + the WebView2
// NuGet, restored automatically): see OpenCuesTray.csproj. Compiles
// OpenCuesWindows.cs (the shim + MiniJson) into the same assembly.
//
// The no-SDK PowerShell tray (OpenCuesTray.ps1) is the equivalent for
// users without a build toolchain; it opens Settings in the default
// browser instead of a WebView2 window. Same daemon, same popup, same
// config API - only the window host differs.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.WinForms;

namespace OpenCues
{
    internal static class TrayProgram
    {
        static Process _daemon;
        static NotifyIcon _icon;
        static System.Windows.Forms.Timer _timer;
        static ToolStripMenuItem _statusItem, _enabledItem, _autostartItem;
        static SettingsWindow _settings;

        static string _mode = "spawn";
        static int _port = 51789;
        static int _cfgPort = 51790;
        static string _daemonHost = "127.0.0.1";
        static string _nodePath = "node";
        static string _hostd = "";
        static string _opencuesHome = "";

        const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunValueName = "OpenCues";

        [STAThread]
        static void Main(string[] args)
        {
            LoadSettings();
            ApplyArgs(args);
            _cfgPort = _port + 1;

            // Per-monitor DPI so the tray menu + settings window scale
            // correctly on HiDPI / mixed-DPI setups. Must precede any window.
            try { Application.SetHighDpiMode(HighDpiMode.PerMonitorV2); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            StartDaemon();
            WindowsShim.Start(_daemonHost, _port);

            BuildTray();
            Application.ApplicationExit += (s, e) => Cleanup();
            Application.Run();
        }

        // --- Settings: tray.json under %LOCALAPPDATA%\OpenCues ----------
        static void LoadSettings()
        {
            try
            {
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenCues");
                string file = Path.Combine(dir, "tray.json");
                if (!File.Exists(file)) return;
                var map = MiniJson.Parse(File.ReadAllText(file)) as Dictionary<string, object>;
                if (map == null) return;
                if (map.ContainsKey("mode") && map["mode"] != null) _mode = map["mode"].ToString();
                if (map.ContainsKey("port") && map["port"] != null) _port = (int)Convert.ToDouble(map["port"], CultureInfo.InvariantCulture);
                if (map.ContainsKey("daemonHost") && map["daemonHost"] != null) _daemonHost = map["daemonHost"].ToString();
                if (map.ContainsKey("nodePath") && map["nodePath"] != null) _nodePath = map["nodePath"].ToString();
                if (map.ContainsKey("hostd") && map["hostd"] != null) _hostd = map["hostd"].ToString();
                if (map.ContainsKey("opencuesHome") && map["opencuesHome"] != null) _opencuesHome = map["opencuesHome"].ToString();
            }
            catch { /* defaults stand */ }
            if (string.IsNullOrEmpty(_hostd))
            {
                // Default: hostd.cjs is two dirs up from this exe's native/ folder.
                string exeDir = AppDomain.CurrentDomain.BaseDirectory;
                string guess = Path.GetFullPath(Path.Combine(exeDir, "..", "src", "hostd.cjs"));
                _hostd = guess;
            }
        }

        static void ApplyArgs(string[] args)
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--mode" && i + 1 < args.Length) _mode = args[++i];
                else if (args[i] == "--port" && i + 1 < args.Length) int.TryParse(args[++i], out _port);
                else if (args[i] == "--host" && i + 1 < args.Length) _daemonHost = args[++i];
                else if (args[i] == "--hostd" && i + 1 < args.Length) _hostd = args[++i];
            }
        }

        // --- Daemon supervision (spawn mode) ----------------------------
        static void StartDaemon()
        {
            if (_mode != "spawn") return;
            if (string.IsNullOrEmpty(_hostd) || !File.Exists(_hostd))
            {
                MessageBox.Show("hostd.cjs not found at:\n" + _hostd + "\n\nSet tray.json.hostd.", "OpenCues");
                return;
            }
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = _nodePath,
                    Arguments = "\"" + _hostd + "\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                psi.EnvironmentVariables["OPENCUES_WIN_PORT"] = _port.ToString(CultureInfo.InvariantCulture);
                psi.EnvironmentVariables["OPENCUES_PARENT_PID"] = Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
                if (!string.IsNullOrEmpty(_opencuesHome)) psi.EnvironmentVariables["OPENCUES_HOME"] = _opencuesHome;
                _daemon = Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to start Node daemon (" + _nodePath + "):\n" + ex.Message, "OpenCues");
            }
        }

        // --- Tray icon + menu -------------------------------------------
        static void BuildTray()
        {
            var menu = new ContextMenuStrip();

            _statusItem = new ToolStripMenuItem("OpenCues - starting") { Enabled = false };
            menu.Items.Add(_statusItem);
            menu.Items.Add(new ToolStripSeparator());

            _enabledItem = new ToolStripMenuItem("Enabled") { Checked = true, CheckOnClick = true };
            _enabledItem.Click += (s, e) => WindowsShim.SetEnabled(_enabledItem.Checked);
            menu.Items.Add(_enabledItem);

            var settingsItem = new ToolStripMenuItem("Settings & keys...");
            settingsItem.Click += (s, e) => ShowSettings();
            menu.Items.Add(settingsItem);

            menu.Items.Add(new ToolStripSeparator());

            var configItem = new ToolStripMenuItem("Open config folder (.cues)");
            configItem.Click += (s, e) =>
            {
                string p = WindowsShim.ConfigPathWin;
                if (string.IsNullOrEmpty(p))
                    p = string.IsNullOrEmpty(_opencuesHome)
                        ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cues")
                        : _opencuesHome;
                try { Process.Start("explorer.exe", p); } catch { }
            };
            menu.Items.Add(configItem);

            var logItem = new ToolStripMenuItem("View log");
            logItem.Click += (s, e) =>
            {
                string l = WindowsShim.LogPathWin;
                if (string.IsNullOrEmpty(l)) l = Path.Combine(Path.GetTempPath(), "opencues.log");
                try { Process.Start("notepad.exe", l); } catch { }
            };
            menu.Items.Add(logItem);

            _autostartItem = new ToolStripMenuItem("Start at login") { CheckOnClick = true, Checked = IsAutostart() };
            _autostartItem.Click += (s, e) => SetAutostart(_autostartItem.Checked);
            menu.Items.Add(_autostartItem);

            menu.Items.Add(new ToolStripSeparator());

            var quitItem = new ToolStripMenuItem("Quit");
            quitItem.Click += (s, e) => Quit();
            menu.Items.Add(quitItem);

            _icon = new NotifyIcon
            {
                Icon = BrandIcon(),
                Text = "OpenCues: starting",
                Visible = true,
                ContextMenuStrip = menu,
            };
            _icon.DoubleClick += (s, e) => ShowSettings();

            _timer = new System.Windows.Forms.Timer { Interval = 1000 };
            _timer.Tick += (s, e) =>
            {
                string st = WindowsShim.StatusLine ?? "";
                _statusItem.Text = "OpenCues - " + st;
                _enabledItem.Checked = WindowsShim.Enabled;
                string t = "OpenCues: " + st;
                _icon.Text = t.Length > 62 ? t.Substring(0, 62) : t;
            };
            _timer.Start();
        }

        static void ShowSettings()
        {
            if (_settings == null || _settings.IsDisposed)
                _settings = new SettingsWindow("http://127.0.0.1:" + _cfgPort.ToString(CultureInfo.InvariantCulture) + "/");
            _settings.Show();
            _settings.WindowState = FormWindowState.Normal;
            _settings.Activate();
        }

        // --- Autostart (HKCU Run) ---------------------------------------
        static bool IsAutostart()
        {
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(RunKeyPath, false))
                    return k != null && k.GetValue(RunValueName) != null;
            }
            catch { return false; }
        }

        static void SetAutostart(bool on)
        {
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(RunKeyPath, true))
                {
                    if (k == null) return;
                    if (on) k.SetValue(RunValueName, "\"" + Application.ExecutablePath + "\"");
                    else k.DeleteValue(RunValueName, false);
                }
            }
            catch { }
        }

        static void Quit()
        {
            Cleanup();
            Application.Exit();
        }

        static void Cleanup()
        {
            try { if (_timer != null) _timer.Stop(); } catch { }
            try { WindowsShim.Stop(); } catch { }
            KillDaemon();
            try { if (_icon != null) { _icon.Visible = false; _icon.Dispose(); } } catch { }
        }

        static void KillDaemon()
        {
            try { if (_daemon != null && !_daemon.HasExited) _daemon.Kill(); } catch { }
        }

        // The OpenCues 'C_' brand icon (same asset family as the chrome
        // extension), shipped next to the exe. System fallback if absent.
        internal static Icon BrandIcon()
        {
            try
            {
                string p = Path.Combine(AppContext.BaseDirectory, "opencues.ico");
                if (File.Exists(p)) return new Icon(p);
            }
            catch { }
            return SystemIcons.Application;
        }
    }

    // --- Embedded WebView2 settings window ------------------------------
    internal sealed class SettingsWindow : Form
    {
        readonly WebView2 _web;
        readonly string _url;

        public SettingsWindow(string url)
        {
            _url = url;
            Text = "OpenCues - Settings & keys";
            Width = 460;
            Height = 720;
            StartPosition = FormStartPosition.CenterScreen;
            MinimizeBox = false;
            MaximizeBox = false;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            try { Icon = TrayProgram.BrandIcon(); } catch { Icon = SystemIcons.Application; }

            _web = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(_web);
            Load += async (s, e) =>
            {
                try
                {
                    await _web.EnsureCoreWebView2Async(null);
                    _web.CoreWebView2.Navigate(_url);
                }
                catch (Exception ex)
                {
                    MessageBox.Show(
                        "Couldn't open the settings window (WebView2 runtime missing?).\n" +
                        "Install the Microsoft Edge WebView2 Runtime, or use the PowerShell tray\n" +
                        "(Settings opens in your browser instead).\n\n" + ex.Message,
                        "OpenCues");
                }
            };
            // Hide instead of dispose on close, so reopening is instant.
            FormClosing += (s, e) =>
            {
                if (e.CloseReason == CloseReason.UserClosing)
                {
                    e.Cancel = true;
                    Hide();
                }
            };
        }
    }
}
