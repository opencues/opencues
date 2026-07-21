// Composition spike - see CompositionSpike.csproj header for what this
// proves.
//
// ROUND 1 FINDING (2026-07-21): HostBackdropBrush works (live sampling
// of behind-window content on a desktop HWND confirmed) but the host-
// backdrop pipeline PRE-BLURS the sampled content - by design, arbitrary
// windows only ever get acrylic-grade processed backdrop, never sharp
// pixels of other windows (that would be a free screen-scrape primitive).
// DPI awareness ruled out as the cause (blur persists under PMv2).
//
// ROUND 2 (this code): DWM THUMBNAILS - the sanctioned sharp path.
// DwmRegisterThumbnail gives a live, SHARP, GPU-composited mirror of
// another window's content, croppable to a SOURCE RECT and placed at a
// destination rect with an opacity knob. Dim = gray underlay + the live
// mirror at partial opacity: blended live glyphs over gray. If this is
// sharp + live + dimmable, it replaces the capture pipeline AND is plain
// Win32 (back-portable into the Add-Type shim, no compiled shim needed).

using System;
using System.Runtime.InteropServices;
using SWF = System.Windows.Forms;
using SD = System.Drawing;

namespace OpenCues.CompositionSpike
{
    internal static class Program
    {
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [STAThread]
        static int Main()
        {
            // Per-Monitor-V2 BEFORE any window exists: a DPI-unaware window
            // on a scaled display is bitmap-stretched by Windows - the
            // whole lens (and the backdrop sampled through it) renders
            // blurry, which reads as a false FAIL on the sharpness check.
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
            Console.WriteLine("[spike] composition backdrop spike starting");
            try
            {
                var form = new LensForm();
                SWF.Application.Run(form);
                return 0;
            }
            catch (Exception ex)
            {
                Console.WriteLine("[spike] FATAL: " + ex);
                return 1;
            }
        }
    }

    // --- Win32 interop -------------------------------------------------


    internal static class Native
    {

        // -- DWM thumbnails (round 2) ----------------------------------

        [StructLayout(LayoutKind.Sequential)]
        public struct Rect { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct DwmThumbnailProperties
        {
            public uint dwFlags;
            public Rect rcDestination;
            public Rect rcSource;
            public byte opacity;
            [MarshalAs(UnmanagedType.Bool)] public bool fVisible;
            [MarshalAs(UnmanagedType.Bool)] public bool fSourceClientAreaOnly;
        }

        public const uint DWM_TNP_RECTDESTINATION = 0x00000001;
        public const uint DWM_TNP_RECTSOURCE = 0x00000002;
        public const uint DWM_TNP_OPACITY = 0x00000004;
        public const uint DWM_TNP_VISIBLE = 0x00000008;
        public const uint DWM_TNP_SOURCECLIENTAREAONLY = 0x00000010;

        [DllImport("dwmapi.dll")]
        public static extern int DwmRegisterThumbnail(IntPtr dest, IntPtr src, out IntPtr thumb);
        [DllImport("dwmapi.dll")]
        public static extern int DwmUpdateThumbnailProperties(IntPtr thumb, ref DwmThumbnailProperties props);
        [DllImport("dwmapi.dll")]
        public static extern int DwmUnregisterThumbnail(IntPtr thumb);

        public static IntPtr FindNotepadWindow()
        {
            foreach (var p in System.Diagnostics.Process.GetProcessesByName("Notepad"))
            {
                if (p.MainWindowHandle != IntPtr.Zero) return p.MainWindowHandle;
            }
            return IntPtr.Zero;
        }
    }

    // --- The lens window -----------------------------------------------

    internal class LensForm : SWF.Form
    {
        const int WS_EX_TOPMOST = 0x0008;
        const int WS_EX_TRANSPARENT = 0x20;
        const int WS_EX_TOOLWINDOW = 0x80;
        const int WS_EX_NOACTIVATE = 0x8000000;

        IntPtr _thumb = IntPtr.Zero;
        SWF.Timer _retry;

        public LensForm()
        {
            FormBorderStyle = SWF.FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = SWF.FormStartPosition.Manual;
            TopMost = true;
            var scr = SWF.Screen.PrimaryScreen.Bounds;
            Bounds = new SD.Rectangle(scr.Left + (scr.Width - 460) / 2, scr.Top + (scr.Height - 150) / 2, 460, 150);
            BackColor = SD.Color.FromArgb(128, 128, 128);   // the dim underlay the mirror blends onto
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override SWF.CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= WS_EX_TOPMOST | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Console.WriteLine("[spike] SPIKE-UP: lens centered on primary screen (460x150).");
            Console.WriteLine("[spike] Mirroring a Notepad window's top-left region into the lens");
            Console.WriteLine("[spike] at 65% opacity over gray. Type in Notepad; watch the lens.");
            Console.WriteLine("[spike] PASS  = SHARP dimmed text, caret blinking, edits live.");
            Console.WriteLine("[spike] FAIL  = blurry / frozen / black.");
            // Notepad may start after us - retry the thumbnail hookup.
            _retry = new SWF.Timer { Interval = 1000 };
            _retry.Tick += (s, a) => TrySetUpThumbnail();
            _retry.Start();
            TrySetUpThumbnail();
        }

        void TrySetUpThumbnail()
        {
            if (_thumb != IntPtr.Zero) return;
            try
            {
                IntPtr src = Native.FindNotepadWindow();
                if (src == IntPtr.Zero) return;   // keep retrying
                int hr = Native.DwmRegisterThumbnail(Handle, src, out _thumb);
                if (hr != 0 || _thumb == IntPtr.Zero)
                {
                    Console.WriteLine("[spike] DwmRegisterThumbnail hr=0x" + hr.ToString("x8"));
                    _thumb = IntPtr.Zero;
                    return;
                }
                var props = new Native.DwmThumbnailProperties
                {
                    dwFlags = Native.DWM_TNP_RECTDESTINATION | Native.DWM_TNP_RECTSOURCE
                        | Native.DWM_TNP_OPACITY | Native.DWM_TNP_VISIBLE | Native.DWM_TNP_SOURCECLIENTAREAONLY,
                    rcDestination = new Native.Rect { Left = 0, Top = 0, Right = ClientSize.Width, Bottom = ClientSize.Height },
                    // Source-crop: the top-left region of Notepad's CLIENT
                    // area, same size as the lens -> 1:1, no scaling blur.
                    rcSource = new Native.Rect { Left = 0, Top = 0, Right = ClientSize.Width, Bottom = ClientSize.Height },
                    opacity = 166,               // ~65% live mirror over the gray underlay = the dim
                    fVisible = true,
                    fSourceClientAreaOnly = true,
                };
                int hr2 = Native.DwmUpdateThumbnailProperties(_thumb, ref props);
                Console.WriteLine("[spike] thumbnail registered (update hr=0x" + hr2.ToString("x8") + ") - source: Notepad");
                _retry.Stop();
            }
            catch (Exception ex)
            {
                Console.WriteLine("[spike] thumbnail setup FAILED: " + ex.Message);
            }
        }

    }
}
