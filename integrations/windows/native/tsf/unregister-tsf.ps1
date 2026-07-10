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

$destDll = Join-Path $env:LOCALAPPDATA 'OpenCues\tsf\opencues-tsf.dll'
if (Test-Path $destDll) {
  $p = Start-Process regsvr32.exe -ArgumentList @('/u', '/s', "`"$destDll`"") -Wait -PassThru
  Write-Host "  regsvr32 /u exit=$($p.ExitCode) (DllUnregisterServer: COM + TSF profile removed)"
  try { Remove-Item $destDll -Force -ErrorAction Stop; Write-Host "  deleted $destDll" }
  catch { Write-Host "  DLL still locked by a running app - it will free on next sign-out/reboot: $destDll" }
} else {
  Write-Host "  no installed DLL found at $destDll (already uninstalled?)"
}
Write-Host "Done. TIP unregistered; nothing left in HKLM CLSID / CTF."
