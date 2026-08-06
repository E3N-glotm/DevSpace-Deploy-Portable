@echo off
setlocal
set "APP_DIR=%~dp0"
set "NODE_EXE=%APP_DIR%..\runtime\node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"
"%NODE_EXE%" "%APP_DIR%plugin-dispatcher.mjs" %*
exit /b %ERRORLEVEL%
