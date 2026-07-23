[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$ShortcutName = 'Murdawk Uplink',
  [string]$DesktopPath = [Environment]::GetFolderPath('Desktop'),
  [switch]$RemoveDuplicateLaunchers
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$hiddenLauncher = Join-Path $repoRoot 'launch-murdawk-uplink.vbs'
$debugLauncher = Join-Path $repoRoot 'launch-murdawk-uplink.cmd'
$shortcutPath = Join-Path $DesktopPath "$ShortcutName.lnk"
$electronIcon = Join-Path $repoRoot 'app\node_modules\electron\dist\electron.exe'
$installedApp = Join-Path $env:LOCALAPPDATA 'Programs\Murdawk Uplink\Murdawk Uplink.exe'

if (-not (Test-Path -LiteralPath $DesktopPath)) {
  New-Item -ItemType Directory -Path $DesktopPath | Out-Null
}

$usingInstalledApp = Test-Path -LiteralPath $installedApp
if ($usingInstalledApp) {
  $targetPath = $installedApp
  $arguments = ''
  $workingDirectory = Split-Path -Parent $installedApp
  $iconLocation = "$installedApp,0"
  $description = 'Murdawk Uplink - DigitalOcean Spaces browser and upload queue'
} else {
  if (-not (Test-Path -LiteralPath $hiddenLauncher)) {
    throw "Installed app and development launcher were not found. Expected: $installedApp or $hiddenLauncher"
  }
  if (-not (Test-Path -LiteralPath $debugLauncher)) {
    throw "Debug launcher not found: $debugLauncher"
  }
  $candidateWscript = Join-Path $env:WINDIR 'System32\wscript.exe'
  $targetPath = if (Test-Path -LiteralPath $candidateWscript) { $candidateWscript } else { 'wscript.exe' }
  $arguments = "`"$hiddenLauncher`""
  $workingDirectory = $repoRoot
  $iconLocation = if (Test-Path -LiteralPath $electronIcon) { "$electronIcon,0" } else { "$targetPath,0" }
  $description = 'Murdawk Uplink - development launcher for DigitalOcean Spaces uploads'
}

if ($PSCmdlet.ShouldProcess($shortcutPath, 'Create or update canonical desktop shortcut')) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $targetPath
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $workingDirectory
  $shortcut.Description = $description
  $shortcut.IconLocation = $iconLocation
  $shortcut.Save()
}

if ($RemoveDuplicateLaunchers) {
  $duplicateNames = @(
    'DigitalOcean Uploader.lnk',
    'DigitalOcean Spaces Uploader.lnk',
    'Murdawk Uplink Hidden.lnk',
    'Murdawk Uplink Debug.lnk',
    'Murdawk Uplink - Debug.lnk',
    'Murdawk Uplink - Dev.lnk'
  )

  foreach ($name in $duplicateNames) {
    $candidate = Join-Path $DesktopPath $name
    if ((Test-Path -LiteralPath $candidate) -and ($candidate -ne $shortcutPath)) {
      if ($PSCmdlet.ShouldProcess($candidate, 'Remove old duplicate uploader shortcut')) {
        Remove-Item -LiteralPath $candidate
      }
    }
  }
} elseif (Test-Path -LiteralPath $DesktopPath) {
  $duplicateCandidates = Get-ChildItem -LiteralPath $DesktopPath -Filter '*.lnk' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '(Murdawk|DigitalOcean|Spaces|Uploader)' -and $_.FullName -ne $shortcutPath } |
    Select-Object -ExpandProperty Name
  if ($duplicateCandidates) {
    Write-Host 'Potential duplicate uploader shortcuts were found. Re-run with -RemoveDuplicateLaunchers to remove known old names:'
    $duplicateCandidates | ForEach-Object { Write-Host "  - $_" }
  }
}

[pscustomobject]@{
  Shortcut = $shortcutPath
  Target = $targetPath
  Arguments = $arguments
  WorkingDirectory = $workingDirectory
  InstalledApp = [bool]$usingInstalledApp
  DuplicateCleanup = [bool]$RemoveDuplicateLaunchers
}
