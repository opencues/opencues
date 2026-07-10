<#
  Install the OpenCues TSF spike DLL (self-elevating - ONE UAC prompt, the
  irreducible cost of a TIP; everything else is programmatic).

  Steps:
    1. Copy opencues-tsf.dll out of the WSL tree to %LOCALAPPDATA%\OpenCues\tsf
       (Windows cannot load a DLL from a \\wsl.localhost path into every app).
    2. regsvr32 it -> DllRegisterServer (COM InprocServer32 + TSF profile +
       keyboard category).
    3. Programmatically enable the language profile for the current user, so
       ideally no Win+Space is needed. (If it still requires manual selection,
       that is kill-question #1's answer - noted in the log.)

  Run from Windows PowerShell 5.1 (it will elevate itself):
    powershell -ExecutionPolicy Bypass -File register-tsf.ps1
#>
$ErrorActionPreference = 'Stop'

# Self-elevate.
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object System.Security.Principal.WindowsPrincipal($id)).IsInRole([System.Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Elevating (UAC)..."
  Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', $PSCommandPath)
  return
}

$srcDll = Join-Path $PSScriptRoot 'opencues-tsf.dll'
if (-not (Test-Path $srcDll)) { throw "opencues-tsf.dll not found next to this script - build it first (build-tsf.sh in WSL)." }

$destDir = Join-Path $env:LOCALAPPDATA 'OpenCues\tsf'
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
# Versioned filename: a running app holds the old DLL locked, so each install
# lands under a fresh name. regsvr32's DllRegisterServer registers whatever
# path it is loaded from, so COM auto-points at this new copy. Old copies are
# harmless orphans (freed on app restart / reboot); unregister sweeps them.
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$destDll = Join-Path $destDir "opencues-tsf-$stamp.dll"
Copy-Item $srcDll $destDll -Force
Write-Host "  copied DLL -> $destDll"

# regsvr32 -> DllRegisterServer (silent).
$p = Start-Process regsvr32.exe -ArgumentList @('/s', "`"$destDll`"") -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "regsvr32 failed (exit $($p.ExitCode))" }
Write-Host "  regsvr32 OK (COM + TSF profile + keyboard category registered)"

# Programmatically add + enable the profile for the current user via the
# ITfInputProcessorProfileMgr / ITfInputProcessorProfiles COM API.
Add-Type -Language CSharp @"
using System;
using System.Runtime.InteropServices;
public static class TsfActivate {
  static readonly Guid CLSID_Profiles = new Guid("33C53A50-F456-4884-B049-85FD643ECFED");
  static readonly Guid IID_Profiles   = new Guid("1F02B6C5-7842-4EE6-8A0B-9A24183A95CA");
  static readonly Guid CLSID_Svc      = new Guid("6E1B4F20-9C3A-4D7E-8B21-2F5A0C9D1E33");
  static readonly Guid GUID_Profile   = new Guid("6E1B4F21-9C3A-4D7E-8B21-2F5A0C9D1E33");
  const ushort LANGID = 0x0409;
  [DllImport("ole32.dll")] static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint ctx, ref Guid iid, out IntPtr ppv);
  [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr p, uint co);
  // ITfInputProcessorProfiles vtable: slot 3 Register .. slot 10 ActivateLanguageProfile,
  // slot 6 EnableLanguageProfile. We call by vtable index via a delegate.
  [DllImport("ole32.dll")] static extern void CoUninitialize();
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int EnableFn(IntPtr self, ref Guid rclsid, ushort langid, ref Guid guidProfile, int enable);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int ActivateFn(IntPtr self, ref Guid rclsid, ushort langid, ref Guid guidProfile);
  public static string Run() {
    CoInitializeEx(IntPtr.Zero, 2);
    IntPtr pp; Guid c = CLSID_Profiles, i = IID_Profiles;
    int hr = CoCreateInstance(ref c, IntPtr.Zero, 1, ref i, out pp);
    if (hr != 0 || pp == IntPtr.Zero) { CoUninitialize(); return "CoCreateInstance(Profiles) hr=0x" + hr.ToString("x8"); }
    IntPtr vtbl = Marshal.ReadIntPtr(pp);
    // ITfInputProcessorProfiles method order (msctf.idl): 0-2 IUnknown, 3 Register,
    // 4 Unregister, 5 AddLanguageProfile, 6 RemoveLanguageProfile, 7 EnumInputProcessorInfo,
    // 8 GetDefaultLanguageProfile, 9 SetDefaultLanguageProfile, 10 ActivateLanguageProfile,
    // 11 GetActiveLanguageProfile, 12 GetLanguageProfileDescription, 13 GetCurrentLanguage,
    // 14 ChangeCurrentLanguage, 15 GetLanguageList, 16 EnumLanguageProfiles,
    // 17 EnableLanguageProfile.
    IntPtr pEnable = Marshal.ReadIntPtr(vtbl, 17 * IntPtr.Size);
    IntPtr pActivate = Marshal.ReadIntPtr(vtbl, 10 * IntPtr.Size);
    var enable = (EnableFn)Marshal.GetDelegateForFunctionPointer(pEnable, typeof(EnableFn));
    var activate = (ActivateFn)Marshal.GetDelegateForFunctionPointer(pActivate, typeof(ActivateFn));
    Guid sc = CLSID_Svc, gp = GUID_Profile;
    int hrE = enable(pp, ref sc, LANGID, ref gp, 1);
    int hrA = activate(pp, ref sc, LANGID, ref gp);
    Marshal.Release(pp);
    CoUninitialize();
    return "EnableLanguageProfile hr=0x" + hrE.ToString("x8") + "  ActivateLanguageProfile hr=0x" + hrA.ToString("x8");
  }
}
"@
Write-Host ("  " + [TsfActivate]::Run())

Write-Host ""
Write-Host "Installed. Now:"
Write-Host "  1. If 'OpenCues TSF (spike)' isn't already active, press Win+Space and pick it."
Write-Host "  2. Click into Discord's message box, type 'hello world'."
Write-Host "  3. Press Ctrl+Alt+J."
Write-Host "  4. Observe: did the text get REPLACED with the marker - flash-free? Editor still typeable?"
Write-Host "  Log: \\wsl.localhost\Ubuntu\tmp\oc-tsf.log"
Write-Host ""
Write-Host "Uninstall: unregister-tsf.ps1"
