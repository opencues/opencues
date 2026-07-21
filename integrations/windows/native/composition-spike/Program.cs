// Composition spike - see CompositionSpike.csproj header for what this
// proves. Deliberately minimal: no effect-graph interop yet (that's the
// engineering AFTER the go/no-go); a HostBackdropBrush visual layered
// under a translucent gray tint already demonstrates live per-region
// backdrop restyling if the platform supports it here at all.

using System;
using System.Numerics;
using System.Runtime.InteropServices;
using SWF = System.Windows.Forms;
using SD = System.Drawing;
using WinComp = Windows.UI.Composition;
using WinRT;

namespace OpenCues.CompositionSpike
{
    internal static class Program
    {
        [STAThread]
        static int Main()
        {
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

    // --- Win32 / WinRT interop -----------------------------------------

    [ComImport, Guid("29E691FA-4567-4DCA-B319-D0F207EB6807"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ICompositorDesktopInterop
    {
        void CreateDesktopWindowTarget(IntPtr hwnd, bool isTopmost, out IntPtr target);
    }

    internal static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct DispatcherQueueOptions
        {
            public int dwSize;
            public int threadType;      // 2 = DQTYPE_THREAD_CURRENT
            public int apartmentType;   // 2 = DQTAT_COM_STA
        }

        [DllImport("CoreMessaging.dll")]
        public static extern int CreateDispatcherQueueController(DispatcherQueueOptions options, out IntPtr controller);

        [StructLayout(LayoutKind.Sequential)]
        public struct AccentPolicy
        {
            public int AccentState;     // 5 = ACCENT_ENABLE_HOSTBACKDROP
            public int AccentFlags;
            public int GradientColor;
            public int AnimationId;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct WindowCompositionAttributeData
        {
            public int Attribute;       // 19 = WCA_ACCENT_POLICY
            public IntPtr Data;
            public int SizeOfData;
        }

        [DllImport("user32.dll")]
        public static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);
    }

    // --- The lens window -----------------------------------------------

    internal class LensForm : SWF.Form
    {
        const int WS_EX_TOPMOST = 0x0008;
        const int WS_EX_TRANSPARENT = 0x20;
        const int WS_EX_TOOLWINDOW = 0x80;
        const int WS_EX_NOACTIVATE = 0x8000000;

        IntPtr _dispatcherQueueController = IntPtr.Zero;   // keep-alive
        WinComp.Compositor _compositor;
        WinComp.CompositionTarget _target;

        public LensForm()
        {
            FormBorderStyle = SWF.FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = SWF.FormStartPosition.Manual;
            TopMost = true;
            Bounds = new SD.Rectangle(200, 80, 460, 150);
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
            try
            {
                SetUpComposition();
                Console.WriteLine("[spike] SPIKE-UP: lens at (200,80) 460x150.");
                Console.WriteLine("[spike] Drag a Notepad window with text under the lens.");
                Console.WriteLine("[spike] PASS  = text visible through the lens, DIMMED, caret blinking live.");
                Console.WriteLine("[spike] FAIL  = lens is black / frozen / shows the wallpaper instead.");
            }
            catch (Exception ex)
            {
                Console.WriteLine("[spike] setup FAILED: " + ex);
            }
        }

        void SetUpComposition()
        {
            // 1. A DispatcherQueue on this thread - the Compositor requires one.
            var opts = new Native.DispatcherQueueOptions
            {
                dwSize = Marshal.SizeOf(typeof(Native.DispatcherQueueOptions)),
                threadType = 2,     // current thread
                apartmentType = 2,  // STA
            };
            int hr = Native.CreateDispatcherQueueController(opts, out _dispatcherQueueController);
            Console.WriteLine("[spike] DispatcherQueueController hr=0x" + hr.ToString("x8"));
            if (hr != 0) throw new InvalidOperationException("CreateDispatcherQueueController failed");

            // 2. Compositor + a target bound to this HWND.
            _compositor = new WinComp.Compositor();
            var interop = _compositor.As<ICompositorDesktopInterop>();
            IntPtr targetAbi;
            interop.CreateDesktopWindowTarget(Handle, true, out targetAbi);
            _target = MarshalInterface<WinComp.CompositionTarget>.FromAbi(targetAbi);
            Console.WriteLine("[spike] DesktopWindowTarget created");

            // 3. Host-backdrop accent on the window - required for
            //    CreateHostBackdropBrush to sample content BEHIND the window.
            var accent = new Native.AccentPolicy { AccentState = 5 };
            IntPtr accentPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Native.AccentPolicy)));
            try
            {
                Marshal.StructureToPtr(accent, accentPtr, false);
                var data = new Native.WindowCompositionAttributeData
                {
                    Attribute = 19,   // WCA_ACCENT_POLICY
                    Data = accentPtr,
                    SizeOfData = Marshal.SizeOf(typeof(Native.AccentPolicy)),
                };
                int ok = Native.SetWindowCompositionAttribute(Handle, ref data);
                Console.WriteLine("[spike] host-backdrop accent set (ok=" + ok + ")");
            }
            finally { Marshal.FreeHGlobal(accentPtr); }

            // 4. Visual tree: backdrop lens + translucent gray tint above it.
            //    If backdrop sampling works, the tinted region shows LIVE
            //    dimmed app content (this is the dim, minus the fancy
            //    saturation graph - which is post-spike engineering).
            var root = _compositor.CreateContainerVisual();
            root.RelativeSizeAdjustment = Vector2.One;

            var lens = _compositor.CreateSpriteVisual();
            lens.RelativeSizeAdjustment = Vector2.One;
            lens.Brush = _compositor.CreateHostBackdropBrush();
            root.Children.InsertAtTop(lens);

            var tint = _compositor.CreateSpriteVisual();
            tint.RelativeSizeAdjustment = Vector2.One;
            tint.Brush = _compositor.CreateColorBrush(Windows.UI.Color.FromArgb(96, 128, 128, 128));
            root.Children.InsertAtTop(tint);

            _target.Root = root;
            Console.WriteLine("[spike] visual tree attached (HostBackdropBrush + tint)");
        }
    }
}
