# WebView2 NuGet Package

This directory holds the unpacked `Microsoft.Web.WebView2` NuGet package used by
`setup/build-native-ui.cjs` to compile `DevSpace-Portable.exe`.

The binary files under this directory are **not tracked** by git (see
`.gitignore`). Restore them with one of the following methods before running
the native UI build.

## Method 1 — Download via nuget CLI (recommended)

```powershell
nuget install Microsoft.Web.WebView2 -Version 1.0.3124.44 `
  -OutputDirectory setup\native\lib\_packages `
  -NonInteractive
$pkg = "setup\native\lib\_packages\Microsoft.Web.WebView2.1.0.3124.44"
Remove-Item -Recurse -Force setup\native\lib\webview2 -ErrorAction SilentlyContinue
Copy-Item -Recurse $pkg setup\native\lib\webview2
```

## Method 2 — Download the .nupkg manually

1. Visit https://www.nuget.org/packages/Microsoft.Web.WebView2#versions-body-tab
2. Download `microsoft.web.webview2.1.0.3124.44.nupkg`
3. Rename the extension to `.zip` and extract into `setup/native/lib/webview2/`
   so that `setup/native/lib/webview2/lib/net462/Microsoft.Web.WebView2.WinForms.dll`
   exists.

## Required files

The build script verifies these files exist before invoking `csc.exe`:

- `lib/net462/Microsoft.Web.WebView2.Core.dll`
- `lib/net462/Microsoft.Web.WebView2.WinForms.dll`
- `runtimes/win-x64/native/WebView2Loader.dll`

Any WebView2 version ≥ 1.0.2592 should work; pin to `1.0.3124.44` for
reproducible builds.
