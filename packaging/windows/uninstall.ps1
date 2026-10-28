# Uninstalls Grove (as Settings > Apps runs it): its folder, Start menu
# shortcut and Apps entry, and the app copy in %LOCALAPPDATA%\Grove. Your
# profile (%LOCALAPPDATA%\Grove\User Data: tabs, logins, history) stays,
# unless -Purge.
param([switch]$Purge)
$ErrorActionPreference = 'Stop'

$dest = $PSScriptRoot
$data = Join-Path $env:LOCALAPPDATA 'Grove'

# Chrome holds the profile's lockfile open while Grove runs.
$lock = Join-Path $data 'User Data\lockfile'
try {
  if (Test-Path $lock) { Remove-Item -Force $lock }
} catch {
  Write-Host 'Grove is running. Quit it, then uninstall again.'
  exit 1
}

Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path ([Environment]::GetFolderPath('Programs')) 'Grove.lnk')
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Grove.lnk')
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Grove'
if ($Purge) {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $data
} else {
  foreach ($f in 'app', 'app.old', 'app.new', 'grove.log', 'grove.log.old') {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $data $f)
  }
}
foreach ($d in "$dest.new", "$dest.old", $dest) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $d }
Write-Host 'Uninstalled Grove.'
if (-not $Purge -and (Test-Path (Join-Path $data 'User Data'))) {
  Write-Host "Your profile is still in $data\User Data."
}
