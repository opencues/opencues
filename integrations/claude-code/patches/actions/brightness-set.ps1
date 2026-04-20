Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class BrightCtl {
    static Guid VS = new Guid("7516b95f-f776-4464-8c53-06167f40cc99");
    static Guid BS = new Guid("aded5e82-b909-4619-9949-f5d71dac0bcb");
    [DllImport("powrprof.dll")] static extern uint PowerGetActiveScheme(IntPtr a, ref IntPtr b);
    [DllImport("powrprof.dll")] static extern uint PowerReadACValueIndex(IntPtr a, ref Guid b, ref Guid c, ref Guid d, ref uint e);
    [DllImport("powrprof.dll")] static extern uint PowerWriteACValueIndex(IntPtr a, ref Guid b, ref Guid c, ref Guid d, uint e);
    [DllImport("powrprof.dll")] static extern uint PowerSetActiveScheme(IntPtr a, ref Guid b);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr a);
    public static int Get() { IntPtr p=IntPtr.Zero; PowerGetActiveScheme(IntPtr.Zero,ref p); Guid s=(Guid)Marshal.PtrToStructure(p,typeof(Guid)); uint v=0; PowerReadACValueIndex(IntPtr.Zero,ref s,ref VS,ref BS,ref v); LocalFree(p); return (int)v; }
    public static void Set(int l) { IntPtr p=IntPtr.Zero; PowerGetActiveScheme(IntPtr.Zero,ref p); Guid s=(Guid)Marshal.PtrToStructure(p,typeof(Guid)); PowerWriteACValueIndex(IntPtr.Zero,ref s,ref VS,ref BS,(uint)l); PowerSetActiveScheme(IntPtr.Zero,ref s); LocalFree(p); }
}
"@
[BrightCtl]::Set($args[0])
