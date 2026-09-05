@echo off
setlocal
set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
call "%~dp0gradlew.bat" --no-daemon clean assembleDebug
exit /b %errorlevel%
