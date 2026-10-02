# BetterClaude installer for Windows.
#
#   irm https://raw.githubusercontent.com/ara-mkr/betterclaude/main/scripts/install.ps1 | iex
#
# Downloads the latest installer from GitHub Releases and runs it silently for
# the current user (no admin rights needed). The installer isn't signed by a
# recognized publisher yet, so a copy downloaded through a browser gets
# SmartScreen's "Windows protected your PC". One fetched here carries no
# "downloaded from the internet" mark, so it installs without that prompt.
# Running it again updates in place.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is far faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = 'ara-mkr/betterclaude'

function Say($message) { Write-Host "==> $message" -ForegroundColor Magenta }

if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'BetterClaude needs 64-bit Windows 10 or 11.'
}

Say 'Finding the latest BetterClaude release...'
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'BetterClaude-installer' }
$asset = $release.assets | Where-Object { $_.name -match '^BetterClaude[ .]Setup[ .].*\.exe$' } | Select-Object -First 1
if (-not $asset) {
  throw "Couldn't find a Windows installer in the latest release. Get it from https://github.com/$repo/releases/latest"
}

$installer = Join-Path $env:TEMP $asset.name
Say "Downloading $($asset.name)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer -UseBasicParsing
Unblock-File -Path $installer

$running = Get-Process -Name 'BetterClaude' -ErrorAction SilentlyContinue
if ($running) {
  Say 'Closing the running BetterClaude...'
  $running | Stop-Process -Force
  Start-Sleep -Seconds 2
}

Say 'Installing...'
$process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
Remove-Item $installer -Force -ErrorAction SilentlyContinue
if ($process.ExitCode -ne 0) {
  throw "The installer exited with code $($process.ExitCode)."
}

$exe = Join-Path $env:LOCALAPPDATA 'Programs\betterclaude\BetterClaude.exe'
if (Test-Path $exe) {
  Say "BetterClaude $($release.tag_name) is installed. Opening it..."
  Start-Process -FilePath $exe
} else {
  Say "BetterClaude $($release.tag_name) is installed. Open it from the Start menu."
}
