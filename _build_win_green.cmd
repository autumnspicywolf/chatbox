@echo off
rem ============================================================================
rem  Windows GREEN / PORTABLE build for Chatbox   (x64, win-unpacked only)
rem
rem  Output:  release\build\win-unpacked\Chatbox.exe     <- double-click to run
rem
rem  Usage:
rem    _build_win_green.cmd              full build (rebuild dist, then package)
rem    _build_win_green.cmd fast         repack only, reuse release\app\dist
rem                                      AND the existing release\app\node_modules
rem    _build_win_green.cmd nobuild      reuse dist, but still refresh node_modules
rem
rem  Why this exists instead of _build_win_dir.cmd
rem  --------------------------------------------
rem  1. _build_win_dir.cmd does NOT run "pnpm run build". It packages whatever is
rem     already in release\app\dist. Any renderer build for another target
rem     (`pnpm run mobile:sync:*` writes the SAME directory) silently ends up
rem     inside the desktop shell.
rem  2. It deleted release\build with a single `rmdir /s /q` guarded by
rem     `if exist`. If that delete fails halfway (a running Chatbox.exe, an
rem     antivirus handle, an Explorer preview), cmd leaves a HALF-DELETED tree
rem     that looks complete from the outside. Because electron-builder's
rem     asarUnpack moves native modules out of app.asar into app.asar.unpacked,
rem     the archive index still lists them while the real files are gone ->
rem     the main process dies on require() before it logs anything, Electron
rem     shows an error dialog, and the app appears to "hang" on launch.
rem     This script kills stale processes, deletes with retries, and never
rem     continues with a leftover directory.
rem  3. It never checked the result. Step 6 below validates the package
rem     (asar <-> app.asar.unpacked consistency, locales, desktop renderer)
rem     and fails the build instead of shipping something unrunnable.
rem
rem  Packaging is x64-only and uses --dir, so no NSIS/arm64 work happens.
rem  To capture a log:  _build_win_green.cmd > _green_build.log 2>&1
rem ============================================================================

setlocal EnableExtensions
cd /d "E:\Users\20582\3D Objects\0Download\MyProject\Chatbox"

set "OUT=release\build\win-unpacked"
set "MODE=%~1"
if "%MODE%"=="" set "MODE=full"

rem --- mirrors ---------------------------------------------------------------
rem Domestic mirrors, reachable directly as well as through the local proxy.
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
set "npm_config_registry=https://registry.npmmirror.com"
set "UPDATE_CHANNEL=alpha"
set "CSC_IDENTITY_AUTO_DISCOVERY=false"

rem --- proxy handling --------------------------------------------------------
rem This machine's user .npmrc points npm at http://127.0.0.1:7890. When that
rem local proxy is down, `beforePack`'s `npm ci` fails even though the mirror
rem is directly reachable. Probe the port and pick a working configuration
rem instead of assuming the proxy is up (which is what the old scripts did).
set "PROXY_URL=http://127.0.0.1:7890"
netstat -ano | findstr /c:":7890" | findstr /i "LISTENING" >nul 2>&1
if errorlevel 1 goto :no_proxy

set "HTTP_PROXY=%PROXY_URL%"
set "HTTPS_PROXY=%PROXY_URL%"
set "http_proxy=%PROXY_URL%"
set "https_proxy=%PROXY_URL%"
set "NO_PROXY=localhost,127.0.0.1,::1"
set "no_proxy=localhost,127.0.0.1,::1"
echo [i] local proxy %PROXY_URL% is listening - using it
goto :npmrc_done

:no_proxy
rem Bypass the dead proxy in the user .npmrc by pointing npm at a clean config.
set "CHATBOX_NPMRC=%TEMP%\chatbox-green-build.npmrc"
> "%CHATBOX_NPMRC%" echo registry=https://registry.npmmirror.com/
set "npm_config_userconfig=%CHATBOX_NPMRC%"
echo [i] %PROXY_URL% is NOT listening - bypassing the user .npmrc proxy, going direct
:npmrc_done

if /i "%MODE%"=="fast" set "CHATBOX_SKIP_APP_DEPS=1"

echo ==== Chatbox green build: mode=%MODE% ====

rem --- 0) release file locks on the previous output --------------------------
rem  A running Chatbox.exe holds release\build\win-unpacked open, which is what
rem  makes the delete step below fail. That process is usually the broken build
rem  sitting behind an invisible error dialog, so killing it is safe.
tasklist /fi "IMAGENAME eq Chatbox.exe" 2>nul | find /i "Chatbox.exe" >nul
if not errorlevel 1 (
  echo [0/5] stopping running Chatbox.exe ...
  taskkill /f /im Chatbox.exe >nul 2>&1
  timeout /t 2 /nobreak >nul
)

rem --- 1) rebuild dist for the DESKTOP target -------------------------------
if /i "%MODE%"=="nobuild" goto :skip_build
if /i "%MODE%"=="fast" goto :skip_build

echo [1/5] building main + preload + renderer for desktop ...
call pnpm run build
if errorlevel 1 goto :fail
goto :after_build

:skip_build
echo [1/5] SKIP build - reusing existing release\app\dist

:after_build

rem --- 2) keep the rcedit blocker neutralised -------------------------------
echo [2/5] neutralising the asar-integrity/rcedit blocker ...
node _fix_asar_integrity.mjs
if errorlevel 1 goto :fail

rem --- 3) delete the old output, with retries and a hard stop ---------------
echo [3/5] removing old %OUT% ...
call :rm_output
if errorlevel 1 goto :fail

rem --- 4) package x64 as a plain directory ----------------------------------
echo [4/5] packaging (win x64, --dir, no installer) ...
call pnpm exec electron-builder build --win --dir --x64 --publish never
if errorlevel 1 goto :fail

rem --- 5) verify the package is actually runnable ---------------------------
echo [5/5] verifying package integrity ...
node _verify_green_pack.mjs "%OUT%"
if errorlevel 1 goto :broken

echo.
echo ============================================================
echo  GREEN PACKAGE READY
echo  %CD%\%OUT%\Chatbox.exe
echo ============================================================
exit /b 0

:broken
echo.
echo ==== VERIFICATION FAILED - the package was produced but is NOT runnable. ====
echo ==== Do not ship it. See the FAIL lines above.                          ====
exit /b 1

:rm_output
setlocal EnableDelayedExpansion
set /a tries=0
:rm_retry
if not exist "release\build" (endlocal & exit /b 0)
set /a tries+=1
if !tries! gtr 3 (
  echo ==== ABORT: release\build could not be deleted after 3 attempts. ====
  echo      Close any running Chatbox.exe (or whatever holds the folder)
  echo      and run this script again. Refusing to continue, because a
  echo      partially deleted output directory produces a broken package.
  endlocal & exit /b 1
)
rmdir /s /q "release\build" >nul 2>&1
if exist "release\build" (
  echo      delete attempt !tries!/3 failed, waiting for handles to clear ...
  timeout /t 2 /nobreak >nul
  goto :rm_retry
)
endlocal & exit /b 0

:fail
echo.
echo ==== BUILD FAILED - see the messages above ====
exit /b 1
