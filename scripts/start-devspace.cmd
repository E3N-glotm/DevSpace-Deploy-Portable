@echo off
setlocal
set "ROOT=%~dp0.."
"%ROOT%\runtime\git\bin\bash.exe" "%ROOT%\scripts\start-devspace.sh"
exit /b %ERRORLEVEL%
