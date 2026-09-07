@echo off
setlocal
call "%~dp0start-boss-browser.cmd" %*
set "launch_result=%errorlevel%"
if not "%launch_result%"=="0" pause
exit /b %launch_result%
