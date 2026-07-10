<#
  Uninstall the OpenCues TSF spike (self-elevating). Full reversal:
  regsvr32 /u -> DllUnregisterServer (removes COM + TSF profile + categories),
  then delete the copied DLL. The DLL file stays locked until every app that
  loaded it exits - sign out / reboot to release it fully if needed.

    powershell -ExecutionPolicy Bypass -File unregister-tsf.ps1
#>
$ErrorActionPreference = 'Continue'

$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object System.Security.Principal.WindowsPrincipal($id)).IsInRole([System.Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Elevating (UAC)..."
  Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', $PSCommandPath)
  return
}

$destDir = Join-Path $env:LOCALAPPDATA 'OpenCues\tsf'
# The registered path is whatever the COM InprocServer32 points at; unregister
# via THAT so DllUnregisterServer runs, then sweep every versioned DLL copy.
$reg = 'HKLM:\SOFTWARE\Classes\CLSID\{6E1B4F20-9C3A-4D7E-8B21-2F5A0C9D1E33}\InprocServer32'
$registered = $null
if (Test-Path $reg) { $registered = (Get-ItemProperty $reg).'(default)' }
if ($registered -and (Test-Path $registered)) {
  $p = Start-Process regsvr32.exe -ArgumentList @('/u', '/s', "`"$registered`"") -Wait -PassThru
  Write-Host "  regsvr32 /u ($registered) exit=$($p.ExitCode)"
} else {
  Write-Host "  no registered DLL path found (already unregistered?)"
}
# Sweep the versioned DLL copies (best-effort; running apps keep some locked).
$dlls = @()
if (Test-Path $destDir) { $dlls = Get-ChildItem $destDir -Filter 'opencues-tsf*.dll' -ErrorAction SilentlyContinue }
$freed = 0; $locked = 0
foreach ($d in $dlls) {
  try { Remove-Item $d.FullName -Force -ErrorAction Stop; $freed++ } catch { $locked++ }
}
Write-Host "  DLL copies deleted=$freed still-locked=$locked (locked ones free on app restart / reboot)"
Write-Host "Done. TIP unregistered; nothing left in HKLM CLSID / CTF."
