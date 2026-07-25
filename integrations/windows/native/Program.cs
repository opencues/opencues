// Entry point for the `dotnet build` / standalone-exe path only.
// The default install route (OpenCuesWindows.ps1 + Add-Type) calls
// OpenCues.WindowsShim.Run directly and does not compile this file.
//
//   OpenCuesWindows.exe --port 51789 [--host 127.0.0.1]

using System;

namespace OpenCues
{
    internal static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            int port = 51789;
            string host = "127.0.0.1";
            for (int i = 0; i < args.Length; i++)
            {
                if ((args[i] == "--port" || args[i] == "-p") && i + 1 < args.Length)
                { int.TryParse(args[++i], out port); }
                else if ((args[i] == "--host" || args[i] == "-h") && i + 1 < args.Length)
                { host = args[++i]; }
            }
            Console.CancelKeyPress += (s, e) => { e.Cancel = true; WindowsShim.Stop(); };
            WindowsShim.Run(host, port);
            return 0;
        }
    }
}
