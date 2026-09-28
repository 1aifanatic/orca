using System;
using System.Diagnostics;
using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class BreakawayProbe
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string reserved, desktop, title;
        public uint x, y, width, height, columns, rows, fill, flags;
        public ushort show, reservedLength;
        public IntPtr reservedBytes, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr process, thread;
        public uint pid, threadId;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string app, StringBuilder command,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
        IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job,
        [MarshalAs(UnmanagedType.Bool)] out bool inJob);
    private static bool InJob()
    {
        bool inJob;
        if (!IsProcessInJob(new IntPtr(-1), IntPtr.Zero, out inJob))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return inJob;
    }
    private static string DirectoryFor(string nonce)
    {
        Guid parsed;
        if (!Guid.TryParseExact(nonce, "N", out parsed)) throw new ArgumentException("Invalid nonce");
        return Path.Combine(Path.GetTempPath(), "orca-breakaway-" + nonce);
    }
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2) return 64;
            string directory = DirectoryFor(args[1]);
            string record = Path.Combine(directory, "witness.txt");
            string stop = Path.Combine(directory, "stop");
            if (args[0] == "--worker")
            {
                long deadline = Stopwatch.GetTimestamp() + Stopwatch.Frequency * 45;
                using (Process self = Process.GetCurrentProcess())
                {
                    string identity = self.Id + " " + self.StartTime.ToUniversalTime().Ticks;
                    int tick = 0;
                    int childInJob = InJob() ? 1 : 0;
                    while (Stopwatch.GetTimestamp() < deadline && !File.Exists(stop))
                    {
                        using (FileStream stream = new FileStream(record, FileMode.Append, FileAccess.Write, FileShare.Read))
                        using (StreamWriter writer = new StreamWriter(stream))
                            writer.WriteLine(identity + " " + tick++ + " " + childInJob);
                        Thread.Sleep(100);
                    }
                }
                return 0;
            }
            if (args[0] == "--launch")
            {
                if (Directory.Exists(directory)) return 65;
                Directory.CreateDirectory(directory);
                string exe = Assembly.GetExecutingAssembly().Location;
                StartupInfo startup = new StartupInfo();
                startup.cb = Marshal.SizeOf(typeof(StartupInfo));
                ProcessInfo process;
                int parentInJob = InJob() ? 1 : 0;
                StringBuilder command = new StringBuilder(QuoteArgument(exe) + " --worker " + QuoteArgument(args[1]));
                // Explicit job breakaway; no inherited SSH handles or console window.
                if (!CreateProcessW(exe, command, IntPtr.Zero, IntPtr.Zero, false,
                    0x01000000 | 0x08000000, IntPtr.Zero, Path.GetDirectoryName(exe), ref startup, out process))
                {
                    int error = Marshal.GetLastWin32Error();
                    Directory.Delete(directory);
                    Console.WriteLine("launch-error " + error);
                    return 1;
                }
                CloseHandle(process.thread);
                CloseHandle(process.process);
                Console.WriteLine("launched " + process.pid + " " + parentInJob);
                return 0;
            }
            if (args[0] == "--read")
            {
                if (!File.Exists(record)) { Console.WriteLine("waiting"); return 2; }
                string snapshot = ReadWitness(record);
                if (snapshot == null) { Console.WriteLine("waiting"); return 2; }
                Console.WriteLine(snapshot);
                return 0;
            }
            if (args[0] == "--inspect" || args[0] == "--cleanup")
            {
                string snapshot = File.Exists(record) ? ReadWitness(record) : null;
                if (snapshot == null) { Console.WriteLine("unverifiable"); return 2; }
                string[] fields = snapshot.Split(' ');
                bool exited;
                try
                {
                    using (Process child = Process.GetProcessById(Int32.Parse(fields[0])))
                        exited = child.StartTime.ToUniversalTime().Ticks != Int64.Parse(fields[1]) || child.HasExited;
                }
                catch (ArgumentException) { exited = true; }
                if (args[0] == "--cleanup" && exited) Directory.Delete(directory, true);
                Console.WriteLine(exited ? "exited" : "live");
                return 0;
            }
            if (args[0] == "--stop")
            {
                if (!Directory.Exists(directory)) return 0;
                File.WriteAllText(stop, "stop");
                Console.WriteLine("stop-requested");
                return 0;
            }
            return 64;
        }
        catch (Exception error)
        {
            Console.WriteLine("probe-error " + error.HResult);
            return 1;
        }
    }
    private static string ReadWitness(string record)
    {
        using (FileStream stream = new FileStream(record, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        using (StreamReader reader = new StreamReader(stream))
        {
            string text = reader.ReadToEnd();
            int newline = text.LastIndexOf('\n');
            if (newline < 0) return null;
            string[] lines = text.Substring(0, newline).TrimEnd('\r').Split('\n');
            return lines[lines.Length - 1].TrimEnd('\r');
        }
    }
    private static string QuoteArgument(string value)
    {
        bool requiresQuotes = value.Length == 0;
        for (int index = 0; index < value.Length && !requiresQuotes; index += 1)
        {
            requiresQuotes = value[index] == '"' || Char.IsWhiteSpace(value[index]);
        }
        if (!requiresQuotes)
        {
            return value;
        }

        StringBuilder quoted = new StringBuilder("\"");
        int backslashCount = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashCount += 1;
                continue;
            }

            if (character == '"')
            {
                quoted.Append('\\', backslashCount * 2 + 1);
                quoted.Append('"');
            }
            else
            {
                quoted.Append('\\', backslashCount);
                quoted.Append(character);
            }
            backslashCount = 0;
        }

        quoted.Append('\\', backslashCount * 2);
        quoted.Append('"');
        return quoted.ToString();
    }
}
