@echo off
rem Grove from a command prompt: "grove sync ..." and "grove mcp" run in this
rem console (see launcher/sync-cli.mjs, launcher/mcp.mjs); anything else (a link, --new-window) goes to
rem Grove.exe, which starts Grove or hands it to the one running.
set "grove_stdio="
if /i "%~1"=="sync" set "grove_stdio=1"
if /i "%~1"=="mcp" set "grove_stdio=1"
if defined grove_stdio (
  "%~dp0node\node.exe" "%LOCALAPPDATA%\Grove\app\launcher\grove.mjs" %*
) else (
  start "" "%~dp0Grove.exe" %*
)
