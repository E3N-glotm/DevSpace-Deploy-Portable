using System;

namespace DevSpacePortable.SshAskPass
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            string password = Environment.GetEnvironmentVariable("DEVSPACE_SSH_PASSWORD") ?? "";
            if (password.Length == 0) return 2;
            Console.Out.Write(password);
            return 0;
        }
    }
}
