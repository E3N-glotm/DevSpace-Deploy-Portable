@echo off
setlocal EnableExtensions
set "ROOT=%~dp0.."
"%ROOT%\runtime\node\node.exe" "%ROOT%\setup\build-native-ui.cjs"
exit /b %ERRORLEVEL%
