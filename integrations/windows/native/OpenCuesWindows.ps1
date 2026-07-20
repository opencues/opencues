<#
.SYNOPSIS
    OpenCues Windows shim launcher.

.DESCRIPTION
    Compiles OpenCuesWindows.cs in-memory (Add-Type - no .NET SDK
    required) and runs the UI Automation shim, which connects to the
    WSL-side OpenCues daemon (oc-windows / hostd.cjs) over a socket and
    mirrors the focused text field.

    Run this from **Windows PowerShell 5.1** (powershell.exe - always
    present on Windows 10/11), NOT pwsh. Add-Type against the GAC
    UIAutomation assemblies is a .NET Framework path.

.PARAMETER Port
    TCP port the WSL daemon is listening on (default 51789, or the
    OPENCUES_WIN_PORT env var). Must match what `oc-windows` printed.

.PARAMETER DaemonHost
    Address of the WSL daemon (default 127.0.0.1 - WSL2 forwards a Linux
    localhost listener to the Windows localhost). Override only if you
    put the daemon on an explicit WSL IP.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File OpenCuesWindows.ps1 -Port 51789
#>
param(
    [int]    $Port = $(if ($env:OPENCUES_WIN_PORT) { [int]$env:OPENCUES_WIN_PORT } else { 51789 }),
    [string] $DaemonHost = $(if ($env:OPENCUES_WIN_BIND) { $env:OPENCUES_WIN_BIND } else { '127.0.0.1' })
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csPath = Join-Path $here 'OpenCuesWindows.cs'

if (-not (Test-Path $csPath)) {
    Write-Error "OpenCuesWindows.cs not found next to this script ($csPath)."
    exit 1
}

Write-Host "OpenCues Windows shim" -ForegroundColor Cyan
Write-Host "  daemon  : $DaemonHost`:$Port"
Write-Host "  source  : $csPath"
Write-Host "  compiling (Add-Type)..."

# UIAutomationClient + UIAutomationTypes are GAC assemblies on .NET
# Framework; UIAutomationClient also needs WindowsBase/PresentationCore
# transitively, which the GAC resolve handles. System / System.Core
# cover TcpClient, Process, LINQ-free collections.
$refs = @(
    'System',
    'System.Core',
    'UIAutomationClient',
    'UIAutomationTypes',
    'WindowsBase',
    'Accessibility',           # MSAA/IA2 IAccessible - the Chromium/Electron read path
    'System.Windows.Forms',    # phase-2 overlay window (OverlayForm)
    'System.Drawing'           # phase-2 overlay painting
)

try {
    Add-Type -Path $csPath -ReferencedAssemblies $refs -ErrorAction Stop
} catch {
    Write-Error "Compilation failed: $($_.Exception.Message)"
    exit 1
}

Write-Host "  compiled OK. attaching to Windows text fields..." -ForegroundColor Green
Write-Host "  (focus a text field in Notepad / WordPad / a dialog and type '<text> fix typos _')"
Write-Host "  Ctrl+C to stop." -ForegroundColor DarkGray

# Ctrl+C -> graceful stop.
try {
    [Console]::TreatControlCAsInput = $false
} catch { }

[OpenCues.WindowsShim]::Run($DaemonHost, $Port)
