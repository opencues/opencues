using System;
using System.Runtime.InteropServices;
using System.Threading;

class VolCtl {
    // --- SendInput for key-press simulation (up/down) ---
    const int INPUT_KEYBOARD = 1;
    const int KEYEVENTF_EXTENDEDKEY = 0x0001;
    const int KEYEVENTF_KEYUP = 0x0002;
    const ushort VK_VOLUME_UP = 0xAF;
    const ushort VK_VOLUME_DOWN = 0xAE;

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT {
        public int type;
        public KEYBDINPUT ki;
        // padding for union
        public int pad1;
        public int pad2;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    static void PressKey(ushort vk) {
        INPUT[] inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].ki.wVk = vk;
        inputs[0].ki.dwFlags = KEYEVENTF_EXTENDEDKEY;
        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].ki.wVk = vk;
        inputs[1].ki.dwFlags = KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP;
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    // --- Core Audio API for get/set ---
    [DllImport("ole32.dll")]
    static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);

    [DllImport("ole32.dll")]
    static extern int CoCreateInstance(ref Guid clsid, IntPtr pOuter, uint ctx, ref Guid iid, out IntPtr ppv);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetDefaultDel(IntPtr self, int dataFlow, int role, out IntPtr ppDevice);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int ActivateDel(IntPtr self, ref Guid iid, uint ctx, IntPtr pParams, out IntPtr ppInterface);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetScalarDel(IntPtr self, out float pfLevel);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int StepDel(IntPtr self, IntPtr pguidEventContext);

    static IntPtr GetEndpointVolume() {
        int hr0 = CoInitializeEx(IntPtr.Zero, 0x2); // COINIT_APARTMENTTHREADED
        if (hr0 != 0 && hr0 != 1)
            CoInitializeEx(IntPtr.Zero, 0x0); // COINIT_MULTITHREADED

        Guid clsid = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
        Guid iidEnum = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");

        IntPtr pEnum;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iidEnum, out pEnum);
        if (hr != 0) return IntPtr.Zero;

        IntPtr vtbl = Marshal.ReadIntPtr(pEnum);
        IntPtr fn = Marshal.ReadIntPtr(vtbl, 4 * IntPtr.Size);
        var getDef = (GetDefaultDel)Marshal.GetDelegateForFunctionPointer(fn, typeof(GetDefaultDel));
        IntPtr pDevice;
        hr = getDef(pEnum, 0, 1, out pDevice);
        if (hr != 0) return IntPtr.Zero;

        IntPtr vtbl2 = Marshal.ReadIntPtr(pDevice);
        IntPtr fn2 = Marshal.ReadIntPtr(vtbl2, 3 * IntPtr.Size);
        var activate = (ActivateDel)Marshal.GetDelegateForFunctionPointer(fn2, typeof(ActivateDel));
        IntPtr pVol;
        Guid iidVol = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        hr = activate(pDevice, ref iidVol, 23, IntPtr.Zero, out pVol);
        if (hr != 0) return IntPtr.Zero;

        return pVol;
    }

    static int GetVolume() {
        IntPtr pVol = GetEndpointVolume();
        if (pVol == IntPtr.Zero) return -1;
        IntPtr vtbl = Marshal.ReadIntPtr(pVol);
        IntPtr fn = Marshal.ReadIntPtr(vtbl, 9 * IntPtr.Size);
        var get = (GetScalarDel)Marshal.GetDelegateForFunctionPointer(fn, typeof(GetScalarDel));
        float level;
        int hr = get(pVol, out level);
        return hr == 0 ? (int)Math.Round(level * 100) : -1;
    }

    static bool SetVolume(int percent) {
        int current = GetVolume();
        if (current < 0) return false;
        IntPtr pVol = GetEndpointVolume();
        if (pVol == IntPtr.Zero) return false;
        int target = Math.Max(0, Math.Min(100, percent));
        int diff = target - current;
        if (diff == 0) return true;
        // VolumeStepUp = vtable 17, VolumeStepDown = vtable 18
        IntPtr vtbl = Marshal.ReadIntPtr(pVol);
        IntPtr fn = Marshal.ReadIntPtr(vtbl, (diff > 0 ? 17 : 18) * IntPtr.Size);
        var step = (StepDel)Marshal.GetDelegateForFunctionPointer(fn, typeof(StepDel));
        int steps = (Math.Abs(diff) + 1) / 2;  // ceiling division — rounds up
        for (int i = 0; i < steps; i++)
            step(pVol, IntPtr.Zero);
        return true;
    }

    static void Main(string[] args) {
        if (args.Length < 1) return;
        string cmd = args[0].ToLower();

        // get: query actual volume via Core Audio API
        if (cmd == "get") {
            int vol = GetVolume();
            Console.WriteLine(vol >= 0 ? vol.ToString() : "50");
            return;
        }

        // set: exact volume via Core Audio API step functions
        if (cmd == "set" && args.Length > 1) {
            int target;
            if (int.TryParse(args[1], out target))
                SetVolume(target);
            return;
        }

        // up/down: key presses via SendInput (fast, shows Windows OSD)
        int amount = 0;
        int.TryParse(args.Length > 1 ? args[1] : "5", out amount);
        if (amount < 1) amount = 5;
        int presses = (amount + 1) / 2;
        if (presses < 1) presses = 1;
        ushort key = cmd == "up" ? VK_VOLUME_UP : VK_VOLUME_DOWN;
        for (int i = 0; i < presses; i++) {
            PressKey(key);
            if (i < presses - 1)
                Thread.Sleep(10);
        }
        // Wait for audio system to process key events before exiting
        Thread.Sleep(150);
    }
}
