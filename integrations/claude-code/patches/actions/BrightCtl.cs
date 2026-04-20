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

    static int GetBrightness(Guid s) {
        uint value = 50;
        PowerReadACValueIndex(IntPtr.Zero, ref s, ref VS, ref BS, ref value);
        return (int)value;
    }

    static void SetBrightness(Guid s, int level) {
        if (level < 0) level = 0;
        if (level > 100) level = 100;
        PowerWriteACValueIndex(IntPtr.Zero, ref s, ref VS, ref BS, (uint)level);
        PowerSetActiveScheme(IntPtr.Zero, ref s);
    }

    static void Main(string[] args) {
        if (args.Length < 1) return;

        IntPtr p = IntPtr.Zero;
        PowerGetActiveScheme(IntPtr.Zero, ref p);
        Guid s = (Guid)Marshal.PtrToStructure(p, typeof(Guid));
        LocalFree(p);

        string cmd = args[0].ToLower();

        if (cmd == "get") {
            Console.WriteLine(GetBrightness(s));
            return;
        }

        if (cmd == "set" && args.Length > 1) {
            int level;
            if (int.TryParse(args[1], out level))
                SetBrightness(s, level);
            return;
        }

        if (cmd == "up" || cmd == "down") {
            int amount = args.Length > 1 ? int.Parse(args[1]) : 10;
            int current = GetBrightness(s);
            int target = cmd == "up" ? current + amount : current - amount;
            SetBrightness(s, target);
            return;
        }

        // Legacy: bare number = absolute set
        int level2;
        if (int.TryParse(args[0], out level2))
            SetBrightness(s, level2);
    }
}
