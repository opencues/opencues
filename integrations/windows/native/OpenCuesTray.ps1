<#
.SYNOPSIS
    OpenCues Windows tray - seamless, one launch runs everything.

.DESCRIPTION
    A single tray icon that starts BOTH halves together and lets you flip
    config source at runtime:

      * spawns the OpenCues daemon (default: inside WSL via wsl.exe, using
        your WSL node - no Windows Node needed) and
      * runs the UIA shim that mirrors your focused text field, and
      * serves the shared settings UI (keys/provider/model).

    Config source is a tray toggle:
      * WSL      -> the daemon reads your WSL  ~/.cues   (default)
      * Windows  -> the daemon reads Windows   %USERPROFILE%\.cues
                   (via /mnt/c from inside WSL)
    Switching restarts the daemon with the new OPENCUES_HOME.

    Lifecycle across the WSL/Windows boundary uses a heartbeat file the
    tray keeps fresh; if the tray quits or crashes, the WSL daemon sees it
    go stale and exits - no orphaned process.

    No .NET SDK. Launch hidden via OpenCuesTray.vbs (also the autostart
    target). The compiled TrayProgram.cs is the WebView2-window equivalent.

.PARAMETER Mode          spawn-wsl (default) | spawn-win | connect
.PARAMETER Port          daemon TCP port (default 51789; config UI on +1)
.PARAMETER ConfigSource  wsl (default) | windows
.PARAMETER Distro        WSL distro (auto-detected from this script's path)
.PARAMETER Hostd         Linux path to hostd.cjs (auto-derived for spawn-wsl)
#>
param(
    [ValidateSet('spawn-wsl', 'spawn-win', 'connect')] [string] $Mode,
    [int]    $Port,
    [ValidateSet('wsl', 'windows')] [string] $ConfigSource,
    [string] $Distro,
    [string] $Hostd,
    [string] $DaemonHost,
    [string] $NodePath,
    [string] $OpencuesHome
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csPath = Join-Path $here 'OpenCuesWindows.cs'
$vbsPath = Join-Path $here 'OpenCuesTray.vbs'
$icoPath = Join-Path $here 'opencues.ico'

# --- Single instance ----------------------------------------------------
# A second launch exits immediately - no duplicate trays, no two daemons
# fighting over the port, no "zombies". The mutex is released when this
# process exits (abandoned-mutex is fine; we only WaitOne(0) to test).
$script:TrayMutex = New-Object System.Threading.Mutex($false, 'Local\OpenCuesTrayInstance')
if (-not $script:TrayMutex.WaitOne(0)) { exit 0 }

# --- DPI awareness (MUST run before any window is created) ---------------
# PowerShell.exe is only System-DPI-aware, so a WinForms menu renders
# unscaled (tiny) on a HiDPI / secondary monitor. Force Per-Monitor-V2 so
# the framework scales the menu to the actual monitor; read the real
# system DPI as a manual-scale fallback for when awareness is already
# locked by the host.
Add-Type -Namespace OpenCuesDpi -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetDpiForSystem();
'@ -ErrorAction SilentlyContinue
$dpiScale = 1.0
try {
    # -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    if (-not [OpenCuesDpi.Native]::SetProcessDpiAwarenessContext([System.IntPtr](-4))) {
        [OpenCuesDpi.Native]::SetProcessDPIAware() | Out-Null
    }
    $sysDpi = [OpenCuesDpi.Native]::GetDpiForSystem()
    if ($sysDpi -ge 96) { $dpiScale = [double]$sysDpi / 96.0 }
} catch { $dpiScale = 1.0 }

# --- tray.json (defaults) merged under explicit params ------------------
$cfgDir = Join-Path $env:LOCALAPPDATA 'OpenCues'
$cfgPath = Join-Path $cfgDir 'tray.json'
$cfg = $null
if (Test-Path $cfgPath) { try { $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch { $cfg = $null } }
function Pick($p, $c, $d) { if ($p) { return $p }; if ($c) { return $c }; return $d }
$Mode         = Pick $Mode         $cfg.mode         'spawn-wsl'
$Port         = [int](Pick $Port   $cfg.port         51789)
$ConfigSource = Pick $ConfigSource $cfg.configSource 'wsl'
$DaemonHost   = Pick $DaemonHost   $cfg.daemonHost   '127.0.0.1'
$NodePath     = Pick $NodePath     $cfg.nodePath     'node'
$OpencuesHome = Pick $OpencuesHome $cfg.opencuesHome ''
$cfgPort = $Port + 1

# --- Derive WSL distro + Linux hostd path from this script's location ---
# When launched from \\wsl.localhost\<distro>\<path>\native\, we can read
# the distro + Linux path straight off the UNC path.
$linuxIntDir = $null
if ($here -match '^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$') {
    if (-not $Distro) { $Distro = $matches[1] }
    $linuxIntDir = '/' + (($matches[2] -replace '\\', '/'))   # .../integrations/windows/native
    $linuxIntDir = $linuxIntDir -replace '/native$', ''       # .../integrations/windows
}
if (-not $Distro) { $Distro = Pick $null $cfg.distro 'Ubuntu' }
if (-not $Hostd -and $cfg.hostd) { $Hostd = $cfg.hostd }
if (-not $Hostd -and $linuxIntDir) { $Hostd = "$linuxIntDir/src/hostd.cjs" }

# Windows %USERPROFILE%\.cues as a /mnt/c path for the WSL daemon.
function Get-MntCuesPath {
    $win = Join-Path $env:USERPROFILE '.cues'                 # C:\Users\you\.cues
    $drive = $win.Substring(0, 1).ToLower()
    return "/mnt/$drive" + ($win.Substring(2) -replace '\\', '/')
}

$hbLinux = "/tmp/oc-win-hb-$Port"
$hbUnc = "\\wsl.localhost\$Distro\tmp\oc-win-hb-$Port"

# --- Load WinForms + the shim -------------------------------------------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$refs = @('System', 'System.Core', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'Accessibility')
try { Add-Type -Path $csPath -ReferencedAssemblies $refs -ErrorAction Stop }
catch { [System.Windows.Forms.MessageBox]::Show("OpenCues shim failed to compile:`n$($_.Exception.Message)", 'OpenCues') | Out-Null; exit 1 }

# --- Daemon lifecycle ---------------------------------------------------
$script:Daemon = $null

function Start-Daemon {
    if ($Mode -eq 'connect') { return }   # dev: daemon already running elsewhere

    if ($Mode -eq 'spawn-wsl') {
        if (-not $Hostd) {
            [System.Windows.Forms.MessageBox]::Show("Couldn't locate hostd.cjs inside WSL.`nLaunch the tray from its \\wsl.localhost path, or set -Hostd / tray.json.hostd.", 'OpenCues') | Out-Null
            return
        }
        # Create the heartbeat file BEFORE spawning (4s grace in the daemon).
        try { Set-Content -Path $hbUnc -Value ([string](Get-Date).Ticks) -ErrorAction SilentlyContinue } catch {}
        $envs = "OPENCUES_WIN_PORT=$Port OPENCUES_HEARTBEAT_FILE='$hbLinux' OPENCUES_HEARTBEAT_TIMEOUT_MS=8000"
        if ($ConfigSource -eq 'windows') { $envs += " OPENCUES_HOME='$(Get-MntCuesPath)'" }
        $bash = "$envs exec node '$Hostd'"
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'wsl.exe'
        # bash -lc -> login shell so nvm/volta node is on PATH (mirrors the
        # chrome-host --shell-type login fix). Paths single-quoted; bash cmd
        # double-quoted as one arg.
        $psi.Arguments = "-d $Distro -- bash -lc `"$bash`""
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        try { $script:Daemon = [System.Diagnostics.Process]::Start($psi) }
        catch { [System.Windows.Forms.MessageBox]::Show("Failed to launch the WSL daemon:`n$($_.Exception.Message)", 'OpenCues') | Out-Null }
        return
    }

    # spawn-win: Windows-Node daemon (general product; needs node.exe).
    $winHostd = if ($Hostd -and (Test-Path $Hostd)) { $Hostd } else { Resolve-Path (Join-Path $here '..\src\hostd.cjs') -ErrorAction SilentlyContinue }
    if (-not $winHostd) { [System.Windows.Forms.MessageBox]::Show("hostd.cjs not found for spawn-win.", 'OpenCues') | Out-Null; return }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $NodePath
    $psi.Arguments = "`"$winHostd`""
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.EnvironmentVariables['OPENCUES_WIN_PORT'] = "$Port"
    $psi.EnvironmentVariables['OPENCUES_PARENT_PID'] = "$PID"
    if ($ConfigSource -eq 'windows' -and -not $OpencuesHome) { $psi.EnvironmentVariables['OPENCUES_HOME'] = (Join-Path $env:USERPROFILE '.cues') }
    elseif ($OpencuesHome) { $psi.EnvironmentVariables['OPENCUES_HOME'] = $OpencuesHome }
    try { $script:Daemon = [System.Diagnostics.Process]::Start($psi) }
    catch { [System.Windows.Forms.MessageBox]::Show("Failed to start Node daemon ($NodePath):`n$($_.Exception.Message)", 'OpenCues') | Out-Null }
}

function Stop-Daemon {
    # Windows-side launcher first.
    if ($script:Daemon -and -not $script:Daemon.HasExited) { try { $script:Daemon.Kill() } catch {} }
    $script:Daemon = $null
    # WSL-side node (the launcher relay may not cascade the kill). No shell
    # runs here (wsl.exe -- pkill directly), so the pattern must NOT be
    # quoted - quotes would become literal chars and match nothing. The
    # pattern has no spaces, so bare is correct.
    if ($Mode -eq 'spawn-wsl') {
        try { Start-Process -FilePath 'wsl.exe' -ArgumentList "-d $Distro -- pkill -f windows/src/hostd.cjs" -NoNewWindow -Wait -ErrorAction SilentlyContinue } catch {}
    }
}

function Restart-Daemon { Stop-Daemon; Start-Sleep -Milliseconds 400; Start-Daemon }

function Save-TrayJson {
    try {
        New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
        @{ mode = $Mode; port = $Port; configSource = $ConfigSource; distro = $Distro; hostd = $Hostd } |
            ConvertTo-Json | Set-Content -Path $cfgPath
    } catch {}
}

Start-Daemon
Save-TrayJson

# --- Start the UIA shim -------------------------------------------------
[OpenCues.WindowsShim]::Start($DaemonHost, $Port)

# --- Autostart (HKCU Run -> hidden vbs) ----------------------------------
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
function Test-Autostart { $null -ne (Get-ItemProperty -Path $runKey -Name 'OpenCues' -ErrorAction SilentlyContinue) }
function Set-Autostart([bool]$on) {
    if ($on) { Set-ItemProperty -Path $runKey -Name 'OpenCues' -Value ("wscript.exe `"$vbsPath`"") }
    else { Remove-ItemProperty -Path $runKey -Name 'OpenCues' -ErrorAction SilentlyContinue }
}

# --- Tray icon + menu ---------------------------------------------------
$notify = New-Object System.Windows.Forms.NotifyIcon
# Brand icon (the OpenCues 'C_' mark, same asset family as the chrome
# extension). Falls back to a system icon if the file is missing.
try {
    if (Test-Path $icoPath) { $notify.Icon = New-Object System.Drawing.Icon($icoPath) }
    else { $notify.Icon = [System.Drawing.SystemIcons]::Application }
} catch { $notify.Icon = [System.Drawing.SystemIcons]::Application }
$notify.Text = 'OpenCues: starting'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
# Natural size: use the system menu font (matches every other app's menu).
# Per-Monitor-V2 awareness (set at startup) does the DPI scaling once -
# do NOT also multiply by $dpiScale or it double-scales (too big).
try { $menu.Font = [System.Windows.Forms.SystemFonts]::MenuFont } catch {}

$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem('OpenCues - starting'); $statusItem.Enabled = $false
[void]$menu.Items.Add($statusItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$enabledItem = New-Object System.Windows.Forms.ToolStripMenuItem('Enabled'); $enabledItem.Checked = $true; $enabledItem.CheckOnClick = $true
$enabledItem.Add_Click({ [OpenCues.WindowsShim]::SetEnabled($enabledItem.Checked) })
[void]$menu.Items.Add($enabledItem)

$settingsItem = New-Object System.Windows.Forms.ToolStripMenuItem('Settings & keys...')
$settingsItem.Add_Click({ try { Start-Process "http://127.0.0.1:$cfgPort/" } catch {} })
[void]$menu.Items.Add($settingsItem)

# Config-source submenu (the WSL <-> Windows toggle).
$cfgMenu = New-Object System.Windows.Forms.ToolStripMenuItem('Config source')
$cfgWsl = New-Object System.Windows.Forms.ToolStripMenuItem('WSL   (~/.cues)')
$cfgWin = New-Object System.Windows.Forms.ToolStripMenuItem('Windows   (%USERPROFILE%\.cues)')
$cfgWsl.Checked = ($ConfigSource -eq 'wsl'); $cfgWin.Checked = ($ConfigSource -eq 'windows')
function Switch-Config([string]$src) {
    if ($src -eq $script:ConfigSource) { return }
    $script:ConfigSource = $src
    $cfgWsl.Checked = ($src -eq 'wsl'); $cfgWin.Checked = ($src -eq 'windows')
    Save-TrayJson
    Restart-Daemon
    $notify.ShowBalloonTip(2000, 'OpenCues', "Config source -> $src (daemon restarted)", [System.Windows.Forms.ToolTipIcon]::Info)
}
$cfgWsl.Add_Click({ Switch-Config 'wsl' })
$cfgWin.Add_Click({ Switch-Config 'windows' })
[void]$cfgMenu.DropDownItems.Add($cfgWsl)
[void]$cfgMenu.DropDownItems.Add($cfgWin)
[void]$menu.Items.Add($cfgMenu)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$configItem = New-Object System.Windows.Forms.ToolStripMenuItem('Open config folder')
$configItem.Add_Click({
    $p = [OpenCues.WindowsShim]::ConfigPathWin
    if (-not $p) { $p = if ($ConfigSource -eq 'windows') { Join-Path $env:USERPROFILE '.cues' } else { "\\wsl.localhost\$Distro\home" } }
    try { Start-Process explorer.exe $p } catch {}
})
[void]$menu.Items.Add($configItem)

$logItem = New-Object System.Windows.Forms.ToolStripMenuItem('View log')
$logItem.Add_Click({
    $l = [OpenCues.WindowsShim]::LogPathWin
    if (-not $l) { $l = "\\wsl.localhost\$Distro\tmp\opencues.log" }
    try { Start-Process notepad.exe $l } catch {}
})
[void]$menu.Items.Add($logItem)

$autostartItem = New-Object System.Windows.Forms.ToolStripMenuItem('Start at login'); $autostartItem.CheckOnClick = $true; $autostartItem.Checked = (Test-Autostart)
$autostartItem.Add_Click({ Set-Autostart($autostartItem.Checked) })
[void]$menu.Items.Add($autostartItem)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem('Quit')
$quitItem.Add_Click({ Stop-All })
[void]$menu.Items.Add($quitItem)

$notify.ContextMenuStrip = $menu

# --- Timers: status refresh + heartbeat touch ---------------------------
$statusTimer = New-Object System.Windows.Forms.Timer; $statusTimer.Interval = 1000
$statusTimer.Add_Tick({
    $s = [OpenCues.WindowsShim]::StatusLine
    $statusItem.Text = "OpenCues - $s   [$ConfigSource]"
    $enabledItem.Checked = [OpenCues.WindowsShim]::Enabled
    $t = "OpenCues: $s"; if ($t.Length -gt 62) { $t = $t.Substring(0, 62) }
    $notify.Text = $t
})
$statusTimer.Start()

$hbTimer = New-Object System.Windows.Forms.Timer; $hbTimer.Interval = 2000
$hbTimer.Add_Tick({ if ($Mode -eq 'spawn-wsl') { try { (Get-Item $hbUnc -ErrorAction SilentlyContinue).LastWriteTime = Get-Date } catch { try { Set-Content -Path $hbUnc -Value ([string](Get-Date).Ticks) -ErrorAction SilentlyContinue } catch {} } } })
$hbTimer.Start()

# Self-healing: if the daemon dies (crash, external kill) and the shim
# can't connect, respawn it. Without this, a dead daemon leaves the tray
# stuck on "waiting for daemon" forever.
$watchTimer = New-Object System.Windows.Forms.Timer; $watchTimer.Interval = 5000
$watchTimer.Add_Tick({
    if ($Mode -eq 'connect') { return }
    if (-not [OpenCues.WindowsShim]::Connected) {
        if (-not $script:Daemon -or $script:Daemon.HasExited) {
            try { Start-Daemon } catch {}
        }
    }
})
$watchTimer.Start()

# --- Clean shutdown -----------------------------------------------------
function Stop-All {
    try { $statusTimer.Stop() } catch {}
    try { $hbTimer.Stop() } catch {}          # stop touching -> WSL daemon self-exits
    try { $watchTimer.Stop() } catch {}
    try { [OpenCues.WindowsShim]::Stop() } catch {}
    Stop-Daemon
    try { $notify.Visible = $false; $notify.Dispose() } catch {}
    try { $script:TrayMutex.ReleaseMutex() } catch {}
    [System.Windows.Forms.Application]::Exit()
}
[System.Windows.Forms.Application]::add_ApplicationExit({ try { $hbTimer.Stop() } catch {}; Stop-Daemon })

# --- Message pump -------------------------------------------------------
$ctx = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($ctx)
