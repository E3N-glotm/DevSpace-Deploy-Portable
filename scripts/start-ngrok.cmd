@echo off
setlocal
set "ROOT=%~dp0.."
call "%ROOT%\scripts\start-tunnel.cmd"
exit /b %ERRORLEVEL%
