# Build yt-player.exe — double-click launcher for the terminal YouTube player.
# Run from the project root:  powershell -ExecutionPolicy Bypass -File tools/build-exe.ps1
# Output: <project-root>\yt-player.exe (keep it next to src\, bin\, package.json)
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $MyInvocation.MyCommand.Path -Parent) -Parent
$outExe = Join-Path $root 'yt-player.exe'

$csharp = @'
using System;
using System.Diagnostics;
using System.IO;

public static class Launcher {
  public static int Main(string[] args) {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    Console.Title = "YouTube Terminal Audio Player";
    // ponytail: window follows the app UI (63 cols min, ~36 rows max) — clamped, never throws
    try {
      Console.WindowWidth = Math.Min(80, Console.LargestWindowWidth);
      Console.WindowHeight = Math.Min(40, Console.LargestWindowHeight);
    } catch { }
    string script = Path.Combine(dir, "src", "index.js");
    if (!File.Exists(script)) {
      Console.WriteLine("Tidak ketemu: " + script);
      Console.WriteLine("Simpan yt-player.exe di folder proyek (sejajar folder src).");
      Console.Write("Tekan tombol apa saja untuk keluar...");
      try { Console.ReadKey(true); } catch { }
      return 1;
    }
    string argLine = "\"" + script + "\"";
    foreach (string a in args) argLine += " \"" + a.Replace("\"", "\\\"") + "\"";
    var psi = new ProcessStartInfo("node", argLine);
    psi.WorkingDirectory = dir;
    psi.UseShellExecute = false;
    try {
      using (var p = Process.Start(psi)) { p.WaitForExit(); return p.ExitCode; }
    } catch (Exception e) {
      Console.WriteLine("Gagal menjalankan node: " + e.Message);
      Console.WriteLine("Pastikan Node.js terinstal dan ada di PATH (jalankan: node --version).");
      Console.Write("Tekan tombol apa saja untuk keluar...");
      try { Console.ReadKey(true); } catch { }
      return 1;
    }
  }
}
'@

Add-Type -TypeDefinition $csharp -OutputAssembly $outExe -OutputType ConsoleApplication
"Built: $outExe"
Get-Item $outExe | Select-Object Name, @{n='KB';e={[math]::Round($_.Length/1KB)}}
