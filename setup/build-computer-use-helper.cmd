@echo off
setlocal EnableExtensions

set "ROOT=%~dp0.."
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo ERROR: Visual Studio Installer vswhere.exe was not found. 1>&2
  exit /b 1
)

for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSROOT=%%I"
if not defined VSROOT (
  echo ERROR: Visual C++ x64 Build Tools were not found. 1>&2
  exit /b 1
)

call "%VSROOT%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b %errorlevel%

set "SOURCE=%ROOT%\setup\native\computer-use-capture.cpp"
set "INPUT_SOURCE=%ROOT%\setup\native\computer-use-input.cpp"
set "OUTPUT_DIR=%ROOT%\app\node_modules\@waishnav\devspace\dist\helpers"
set "OUTPUT=%OUTPUT_DIR%\computer-use-capture.exe"
set "INPUT_OUTPUT=%OUTPUT_DIR%\computer-use-input.exe"
set "OBJECT=%TEMP%\devspace-computer-use-capture-%RANDOM%-%RANDOM%.obj"
set "INPUT_OBJECT=%TEMP%\devspace-computer-use-input-%RANDOM%-%RANDOM%.obj"

if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"

cl.exe /nologo /std:c++20 /EHsc /O2 /MT /W4 /DUNICODE /D_UNICODE ^
  /Fo"%OBJECT%" "%SOURCE%" /Fe"%OUTPUT%" ^
  /link /SUBSYSTEM:CONSOLE d3d11.lib dxgi.lib windowscodecs.lib windowsapp.lib ole32.lib user32.lib gdi32.lib
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" goto cleanup

cl.exe /nologo /std:c++20 /EHsc /O2 /MT /W4 /DUNICODE /D_UNICODE ^
  /Fo"%INPUT_OBJECT%" "%INPUT_SOURCE%" /Fe"%INPUT_OUTPUT%" ^
  /link /SUBSYSTEM:CONSOLE user32.lib
set "RESULT=%ERRORLEVEL%"

:cleanup
del /q "%OBJECT%" >nul 2>&1
del /q "%INPUT_OBJECT%" >nul 2>&1
exit /b %RESULT%

