using System;
using System.Runtime.InteropServices;

class BrightCtl {
    static Guid VS = new Guid("7516b95f-f776-4464-8c53-06167f40cc99");
    static Guid BS = new Guid("aded5e82-b909-4619-9949-f5d71dac0bcb");

    [DllImport("powrprof.dll")] static extern uint PowerGetActiveScheme(IntPtr a, ref IntPtr b);
    [DllImport("powrprof.dll")] static extern uint PowerReadACValueIndex(IntPtr a, ref Guid b, ref Guid c, ref Guid d, ref uint e);
    [DllImport("powrprof.dll")] static extern uint PowerWriteACValueIndex(IntPtr a, ref Guid b, ref Guid c, ref Guid d, uint e);
    [DllImport("powrprof.dll")] static extern uint PowerSetActiveScheme(IntPtr a, ref Guid b);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr a);

    static void Main(string[] args) {
        if (args.Length < 1) return;
        int level;
        if (!int.TryParse(args[0], out level)) return;
        if (level < 0) level = 0;
        if (level > 100) level = 100;

        IntPtr p = IntPtr.Zero;
        PowerGetActiveScheme(IntPtr.Zero, ref p);
        Guid s = (Guid)Marshal.PtrToStructure(p, typeof(Guid));
        PowerWriteACValueIndex(IntPtr.Zero, ref s, ref VS, ref BS, (uint)level);
        PowerSetActiveScheme(IntPtr.Zero, ref s);
        LocalFree(p);
    }
}
