@echo off
rem Grove from a command prompt: "grove sync ..." runs in this console (see
rem launcher/sync-cli.mjs); anything else (a link, --new-window) goes to
rem Grove.exe, which starts Grove or hands it to the one running.
if /i "%~1"=="sync" (
  "%~dp0node\node.exe" "%LOCALAPPDATA%\Grove\app\launcher\grove.mjs" %*
) else (
  start "" "%~dp0Grove.exe" %*
)
