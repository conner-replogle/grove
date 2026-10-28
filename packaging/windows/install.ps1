# Installs Grove on Windows from its latest GitHub release:
#
#   irm https://github.com/conner-replogle/grove/releases/latest/download/install.ps1 | iex
#
# In %LOCALAPPDATA%\Programs\Grove, with a Start menu shortcut and an entry
# in Settings > Apps (which uninstalls it). No administrator rights needed.
# Run it again to reinstall; Grove also updates itself.
#
#   $env:GROVE_VERSION = '0.2.0'       a release other than the latest
#   $env:GROVE_BUNDLE = '<file>'       install a bundle on disk (scripts/bundle.mjs)
#   $env:GROVE_INSTALL_DIR = '<dir>'   install somewhere else
#   $env:GROVE_REPO = 'owner/name'     another repository (default conner-replogle/grove)
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $repo = if ($env:GROVE_REPO) { $env:GROVE_REPO } else { 'conner-replogle/grove' }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
  $platform = "windows-$arch"
  $dest = if ($env:GROVE_INSTALL_DIR) { $env:GROVE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\Grove' }

  $work = Join-Path ([IO.Path]::GetTempPath()) "grove-install-$PID"
  New-Item -ItemType Directory -Force $work | Out-Null
  try {
    if ($env:GROVE_BUNDLE) {
      $bundle = $env:GROVE_BUNDLE
      if (-not (Test-Path $bundle)) { throw "no file $bundle" }
    } else {
      $version = $env:GROVE_VERSION
      if (-not $version) {
        $version = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'grove-install' }).tag_name
      }
      $version = $version -replace '^v', ''
      $name = "grove-$version-$platform.zip"
      $base = "https://github.com/$repo/releases/download/v$version"
      Write-Host "Downloading Grove $version for $platform..."
      $bundle = Join-Path $work $name
      Invoke-WebRequest "$base/$name" -OutFile $bundle -UseBasicParsing
      $sums = Invoke-WebRequest "$base/SHA256SUMS" -UseBasicParsing
      $text = if ($sums.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($sums.Content) } else { $sums.Content }
      $line = ($text -split "`n") | Where-Object { $_ -match "^[0-9a-f]{64}\s+\*?$([regex]::Escape($name))\s*$" } | Select-Object -First 1
      if (-not $line -or $line.Substring(0, 64) -ne (Get-FileHash -Algorithm SHA256 $bundle).Hash.ToLower()) {
        throw "$name doesn't match the release's SHA256SUMS"
      }
    }

    Write-Host 'Unpacking...'
    $unpacked = Join-Path $work 'unpacked'
    Expand-Archive -LiteralPath $bundle -DestinationPath $unpacked
    $new = Join-Path $unpacked 'Grove'
    if (-not (Test-Path (Join-Path $new 'Grove.exe'))) { throw "that isn't a Windows Grove bundle" }
    $info = Get-Content -Raw (Join-Path $new 'bundle.json') | ConvertFrom-Json

    # In place, keeping the old copy until the end. While Grove runs its
    # folder can't move: the new one waits beside it as Grove.new, and
    # Grove.exe swaps it in at the next start.
    New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$dest.new", "$dest.old"
    Move-Item $new "$dest.new"
    $staged = $false
    if (Test-Path $dest) {
      try { Move-Item $dest "$dest.old" } catch { $staged = $true }
    }
    if (-not $staged) {
      Move-Item "$dest.new" $dest
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$dest.old"
    }

    $exe = Join-Path $dest 'Grove.exe'
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'Grove.lnk'))
    $link.TargetPath = $exe
    $link.WorkingDirectory = $dest
    $link.IconLocation = "$exe,0"
    $link.Description = 'Grove'
    $link.Save()

    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Grove'
    New-Item -Force $key | Out-Null
    $size = [int]((Get-ChildItem -Recurse -File $(if ($staged) { "$dest.new" } else { $dest }) | Measure-Object Length -Sum).Sum / 1KB)
    foreach ($v in @(
        @('DisplayName', 'Grove', 'String'),
        @('DisplayVersion', $info.version, 'String'),
        @('Publisher', 'Grove', 'String'),
        @('DisplayIcon', "$exe,0", 'String'),
        @('InstallLocation', $dest, 'String'),
        @('UninstallString', "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$dest\uninstall.ps1`"", 'String'),
        @('URLInfoAbout', "https://github.com/$repo", 'String'),
        @('NoModify', 1, 'DWord'),
        @('NoRepair', 1, 'DWord'),
        @('EstimatedSize', $size, 'DWord'))) {
      New-ItemProperty -Force -Path $key -Name $v[0] -Value $v[1] -PropertyType $v[2] | Out-Null
    }

    if ($staged) {
      Write-Host "Grove $($info.version) is ready: it takes over the next time Grove starts."
    } else {
      Write-Host "Installed Grove $($info.version) in $dest. Start it from the Start menu."
    }
  } finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $work
  }
}
