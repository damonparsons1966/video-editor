$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$destDir = Join-Path $root "src-tauri\binaries"
$dest = Join-Path $destDir "ffmpeg-x86_64-pc-windows-msvc.exe"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null

if (Test-Path $dest) {
    Write-Host "FFmpeg sidecar already exists: $dest"
    exit 0
}

$wingetCandidates = @(
    "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.1-essentials_build\bin\ffmpeg.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.1-full_build\bin\ffmpeg.exe"
)
foreach ($candidate in $wingetCandidates) {
    if (Test-Path $candidate) {
        Copy-Item $candidate $dest -Force
        Write-Host "Copied $candidate -> $dest"
        exit 0
    }
}

$zipUrl = "https://github.com/GyanD/codexffmpeg/releases/download/9.0.1/ffmpeg-9.0.1-essentials_build.zip"
$zip = Join-Path $env:TEMP "ffmpeg-9.0.1-essentials_build.zip"
$extract = Join-Path $env:TEMP "ffmpeg-9.0.1-essentials_build"
Write-Host "Downloading FFmpeg essentials..."
curl.exe -L --retry 3 --output $zip $zipUrl
if ($LASTEXITCODE -ne 0) {
    throw "Download failed with exit code $LASTEXITCODE"
}
if (Test-Path $extract) {
    Remove-Item $extract -Recurse -Force
}
Expand-Archive -Path $zip -DestinationPath $extract -Force
$ffmpeg = Get-ChildItem -Path $extract -Recurse -Filter ffmpeg.exe | Select-Object -First 1
if (-not $ffmpeg) {
    throw "ffmpeg.exe was not found in the downloaded archive."
}
Copy-Item $ffmpeg.FullName $dest -Force
Write-Host "Copied $($ffmpeg.FullName) -> $dest"
