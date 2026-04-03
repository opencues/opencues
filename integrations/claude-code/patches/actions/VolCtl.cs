using System;
using System.Runtime.InteropServices;
using System.Threading;

class VolCtl {
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

    static void Main(string[] args) {
        if (args.Length < 1) return;
        string dir = args[0].ToLower();
        int amount = args.Length > 1 ? 0 : 0;
        int.TryParse(args.Length > 1 ? args[1] : "5", out amount);
        if (amount < 1) amount = 5;

        // Each key press changes volume by ~2%
        int presses = amount / 2;
        if (presses < 1) presses = 1;

        ushort key = dir == "up" ? VK_VOLUME_UP : VK_VOLUME_DOWN;
        for (int i = 0; i < presses; i++) {
            PressKey(key);
            if (presses > 1 && i < presses - 1)
                Thread.Sleep(10);
        }
    }
}
