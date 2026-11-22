@echo off
setlocal
pushd "%~dp0" || exit /b 1
node apps\lab\main.ts open
set "LAB_LAUNCH_CODE=%ERRORLEVEL%"
popd
exit /b %LAB_LAUNCH_CODE%
