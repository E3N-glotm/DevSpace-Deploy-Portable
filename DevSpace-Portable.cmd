@echo off
setlocal
set "ROOT=%~dp0"
if "%~1"=="" (
  if not exist "%ROOT%DevSpace-Portable.exe" (
    echo ERROR: Native DevSpace Portable UI is missing: "%ROOT%DevSpace-Portable.exe" 1>&2
    exit /b 1
  )
  start "DevSpace Portable" "%ROOT%DevSpace-Portable.exe"
  exit /b 0
)
"%ROOT%runtime\node\node.exe" "%ROOT%setup\portable-manager.cjs" %*
exit /b %ERRORLEVEL%
