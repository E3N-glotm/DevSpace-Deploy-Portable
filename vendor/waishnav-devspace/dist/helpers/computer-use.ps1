param(
  [Parameter(Mandatory = $true)][string]$InputFile,
  [Parameter(Mandatory = $true)][string]$OutputFile
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$nativeSource = @"
using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class DevSpaceUser32 {
  private const uint DESKTOP_READOBJECTS = 0x0001;
  private const uint DESKTOP_WRITEOBJECTS = 0x0080;
  private const uint DESKTOP_SWITCHDESKTOP = 0x0100;
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);
  [DllImport("user32.dll", SetLastError=true)] private static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("gdi32.dll", CharSet=CharSet.Auto)] private static extern IntPtr CreateDC(string driver, string device, string output, IntPtr initData);
  [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int width, int height);
  [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr value);
  [DllImport("gdi32.dll", SetLastError=true)] private static extern bool BitBlt(IntPtr destination, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint operation);
  [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
  [DllImport("gdi32.dll")] private static extern uint GetObjectType(IntPtr value);

  public static void AssertInteractiveDesktop() {
    IntPtr desktop = OpenInputDesktop(0, false, DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS | DESKTOP_SWITCHDESKTOP);
    if (desktop == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      throw new Win32Exception(error,
        "The interactive input desktop is unavailable. Open DevSpace Portable UI from the signed-in Windows desktop and keep the session unlocked (error " + error + ")");
    }
    CloseDesktop(desktop);
  }

  public static void CaptureDesktop(string outputFile, int left, int top, int width, int height) {
    const uint SRCCOPY = 0x00CC0020;
    const uint CAPTUREBLT = 0x40000000;
    IntPtr source = CreateDC("DISPLAY", null, null, IntPtr.Zero);
    if (source == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateDC(DISPLAY) failed");
    IntPtr destination = IntPtr.Zero;
    IntPtr bitmap = IntPtr.Zero;
    IntPtr previous = IntPtr.Zero;
    try {
      destination = CreateCompatibleDC(source);
      if (destination == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateCompatibleDC failed");
      bitmap = CreateCompatibleBitmap(source, width, height);
      if (bitmap == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateCompatibleBitmap failed");
      previous = SelectObject(destination, bitmap);
      if (previous == IntPtr.Zero || previous == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "SelectObject failed");
      if (!BitBlt(destination, 0, 0, width, height, source, left, top, SRCCOPY | CAPTUREBLT)
          && !BitBlt(destination, 0, 0, width, height, source, left, top, SRCCOPY)) {
        int error = Marshal.GetLastWin32Error();
        throw new Win32Exception(error,
          "BitBlt failed (error " + error
          + ", source=" + source.ToInt64() + "/type=" + GetObjectType(source)
          + ", destination=" + destination.ToInt64() + "/type=" + GetObjectType(destination)
          + ", bitmap=" + bitmap.ToInt64() + "/type=" + GetObjectType(bitmap)
          + ", previous=" + previous.ToInt64() + "/type=" + GetObjectType(previous) + ")");
      }
      using (Image image = Image.FromHbitmap(bitmap)) {
        image.Save(outputFile, ImageFormat.Png);
      }
    }
    finally {
      if (previous != IntPtr.Zero && previous != new IntPtr(-1) && destination != IntPtr.Zero) SelectObject(destination, previous);
      if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
      if (destination != IntPtr.Zero) DeleteDC(destination);
      if (source != IntPtr.Zero) DeleteDC(source);
    }
  }
}
"@
Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies "System.Drawing"

[DevSpaceUser32]::SetProcessDPIAware() | Out-Null
$document = Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json
$payload = if ($null -ne $document.payload) { $document.payload } else { $document }
$action = [string]$payload.action
if ($action -ne "broker_probe") { [DevSpaceUser32]::AssertInteractiveDesktop() }

function Invoke-Mouse([uint32]$flags, [int]$data = 0) {
  $encoded = [System.BitConverter]::ToUInt32([System.BitConverter]::GetBytes([int32]$data), 0)
  [DevSpaceUser32]::mouse_event($flags, 0, 0, $encoded, [UIntPtr]::Zero)
}

function Set-Point([object]$value) {
  if ($null -eq $value.x -or $null -eq $value.y) { throw "x and y are required for this action" }
  if (-not [DevSpaceUser32]::SetCursorPos([int]$value.x, [int]$value.y)) { throw "SetCursorPos failed" }
}

function Escape-SendKeys([string]$text) {
  $builder = New-Object System.Text.StringBuilder
  foreach ($character in $text.ToCharArray()) {
    switch ($character) {
      "`r" { }
      "`n" { [void]$builder.Append("{ENTER}") }
      "`t" { [void]$builder.Append("{TAB}") }
      "+" { [void]$builder.Append("{+}") }
      "^" { [void]$builder.Append("{^}") }
      "%" { [void]$builder.Append("{%}") }
      "~" { [void]$builder.Append("{~}") }
      "(" { [void]$builder.Append("{(}") }
      ")" { [void]$builder.Append("{)}") }
      "[" { [void]$builder.Append("{[}") }
      "]" { [void]$builder.Append("{]}") }
      "{" { [void]$builder.Append("{{}") }
      "}" { [void]$builder.Append("{}}") }
      default { [void]$builder.Append($character) }
    }
  }
  return $builder.ToString()
}

function Send-SafeKey([string]$key) {
  $map = @{
    "ENTER" = "{ENTER}"; "TAB" = "{TAB}"; "ESCAPE" = "{ESC}"; "BACKSPACE" = "{BACKSPACE}";
    "DELETE" = "{DELETE}"; "UP" = "{UP}"; "DOWN" = "{DOWN}"; "LEFT" = "{LEFT}"; "RIGHT" = "{RIGHT}";
    "HOME" = "{HOME}"; "END" = "{END}"; "PAGEUP" = "{PGUP}"; "PAGEDOWN" = "{PGDN}";
    "CTRL+A" = "^a"; "CTRL+C" = "^c"; "CTRL+V" = "^v"; "CTRL+X" = "^x"; "CTRL+Z" = "^z";
    "CTRL+Y" = "^y"; "CTRL+S" = "^s"; "CTRL+F" = "^f"; "CTRL+L" = "^l";
    "ALT+F4" = "%{F4}"; "F1" = "{F1}"; "F2" = "{F2}"; "F3" = "{F3}"; "F4" = "{F4}";
    "F5" = "{F5}"; "F6" = "{F6}"; "F7" = "{F7}"; "F8" = "{F8}"; "F9" = "{F9}";
    "F10" = "{F10}"; "F11" = "{F11}"; "F12" = "{F12}"
  }
  $normalized = $key.ToUpperInvariant()
  if (-not $map.ContainsKey($normalized)) { throw "Unsupported key: $key" }
  [System.Windows.Forms.SendKeys]::SendWait($map[$normalized])
}

switch ($action) {
  "broker_probe" { }
  "snapshot" { }
  "move" { Set-Point $payload }
  "click" {
    Set-Point $payload
    Invoke-Mouse 0x0002
    Invoke-Mouse 0x0004
  }
  "double_click" {
    Set-Point $payload
    1..2 | ForEach-Object { Invoke-Mouse 0x0002; Invoke-Mouse 0x0004; Start-Sleep -Milliseconds 75 }
  }
  "right_click" {
    Set-Point $payload
    Invoke-Mouse 0x0008
    Invoke-Mouse 0x0010
  }
  "scroll" {
    if ($null -ne $payload.x -and $null -ne $payload.y) { Set-Point $payload }
    Invoke-Mouse 0x0800 ([int]$payload.delta)
  }
  "keypress" {
    foreach ($key in @($payload.keys)) { Send-SafeKey ([string]$key) }
  }
  "type_text" {
    [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys ([string]$payload.text)))
  }
  default { throw "Unsupported Computer Use action: $action" }
}

$delay = [int]($payload.delayMs)
if ($delay -gt 0) { Start-Sleep -Milliseconds ([Math]::Min($delay, 3000)) }

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($payload.screenshotAfter -ne $false) {
  $captureExe = Join-Path $PSScriptRoot "computer-use-capture.exe"
  $dxgiError = $null
  if (Test-Path -LiteralPath $captureExe) {
    $captureOutput = & $captureExe $OutputFile 2>&1
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutputFile)) {
      $dxgiError = ($captureOutput | Out-String).Trim()
      Remove-Item -LiteralPath $OutputFile -Force -ErrorAction SilentlyContinue
    }
  }
  else {
    $dxgiError = "DXGI capture helper is missing: $captureExe"
  }

  if ($null -ne $dxgiError) {
    $managedError = $null
    try {
      $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.CopyFromScreen(
          $bounds.Left,
          $bounds.Top,
          0,
          0,
          $bounds.Size,
          [System.Drawing.CopyPixelOperation]::SourceCopy
        )
        $bitmap.Save($OutputFile, [System.Drawing.Imaging.ImageFormat]::Png)
      }
      finally {
        $graphics.Dispose()
        $bitmap.Dispose()
      }
    }
    catch {
      $managedError = $_.Exception.Message
      try {
        [DevSpaceUser32]::CaptureDesktop($OutputFile, $bounds.Left, $bounds.Top, $bounds.Width, $bounds.Height)
      }
      catch {
        throw "Desktop capture failed. DXGI path: $dxgiError Managed path: $managedError GDI path: $($_.Exception.Message)"
      }
    }
  }
}

[ordered]@{
  action = $action
  left = $bounds.Left
  top = $bounds.Top
  width = $bounds.Width
  height = $bounds.Height
  screenshot = ($payload.screenshotAfter -ne $false)
} | ConvertTo-Json -Compress
