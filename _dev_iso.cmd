@echo off
rem ============================================================
rem Round 29: launch dev with an ISOLATED userData profile.
rem Why: two Chatbox instances sharing %APPDATA%\xyz.chatboxapp.ce
rem      fight over the Chromium quota database -> IndexedDB dies
rem      -> "Session repository operation failed: initialize".
rem Usage (run from cmd, NOT PowerShell):
rem   _dev_iso.cmd
rem   set DEV_PORT=1313 && _dev_iso.cmd
rem   set CBX_DEV_PROFILE=D:\cbx-dev && _dev_iso.cmd
rem NOTE: PowerShell eats a bare "--", which makes electron-vite
rem       fail with "Unknown option `--userDataDir`". Use cmd.
rem ============================================================
setlocal
cd /d "%~dp0"
if not defined DEV_PORT set DEV_PORT=1213
if not defined CBX_DEV_PROFILE set CBX_DEV_PROFILE=%TEMP%\chatbox-dev
echo [dev:iso] DEV_PORT=%DEV_PORT%
echo [dev:iso] profile =%CBX_DEV_PROFILE%
node node_modules\electron-vite\bin\electron-vite.js dev -- --user-data-dir="%CBX_DEV_PROFILE%"
endlocal
