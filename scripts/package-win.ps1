# Builds the Windows installer (dist\Aether-Setup-<version>.exe).
# NSIS cannot read include files from very long paths (MAX_PATH): when the project lives in a deep
# folder, the build is staged in a short temporary folder and the installer is written back to .\dist.
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
Set-Location $project
npx -y pnpm@10 build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
$probe = Join-Path $project 'node_modules\app-builder-lib\templates\nsis\include\allowOnlyOneInstallerInstance.nsh'
if ($probe.Length -lt 240) {
  npx electron-builder --win --x64
} else {
  $stage = Join-Path $env:TEMP 'aether-pkg'
  Write-Host "Chemin du projet trop long pour NSIS : construction dans $stage"
  robocopy $project $stage /MIR /XD (Join-Path $project 'dist') (Join-Path $project 'test-results') /NFL /NDL /NJH /NJS /NP | Out-Null
  Push-Location $stage
  try { npx electron-builder --win --x64 "--config.directories.output=$project\dist" } finally { Pop-Location }
}
if ($LASTEXITCODE -ne 0) { throw 'Packaging failed' }
Get-ChildItem (Join-Path $project 'dist') -Filter '*.exe' | Select-Object FullName, Length
