@echo off
setlocal
where pwsh >nul 2>nul
if %errorlevel%==0 (set _PS=pwsh) else (set _PS=PowerShell)
"%_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-boss-browser.ps1" %*
