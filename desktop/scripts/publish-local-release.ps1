[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$UpdateRoot = (Join-Path $env:LOCALAPPDATA 'KeeMASH\updates')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$desktopRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$packagePath = Join-Path $desktopRoot 'package.json'
$tauriPath = Join-Path $desktopRoot 'src-tauri\tauri.conf.json'
$cargoPath = Join-Path $desktopRoot 'src-tauri\Cargo.toml'
$package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
$tauri = Get-Content -Raw -LiteralPath $tauriPath | ConvertFrom-Json
$cargoText = Get-Content -Raw -LiteralPath $cargoPath
$cargoVersion = [regex]::Match($cargoText, '(?m)^version\s*=\s*"([^"]+)"').Groups[1].Value
$version = [string]$package.version

if (-not $version -or $tauri.version -ne $version -or $cargoVersion -ne $version) {
    throw "Version mismatch: package=$version, tauri=$($tauri.version), cargo=$cargoVersion"
}
if (-not $env:LOCALAPPDATA -and $UpdateRoot -like '*KeeMASH*') {
    throw 'LOCALAPPDATA is unavailable. Pass -UpdateRoot explicitly.'
}

Push-Location $desktopRoot
try {
    if (-not $SkipBuild) {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Full KeeMASH validation failed.' }
        & npm.cmd run test:update-helper
        if ($LASTEXITCODE -ne 0) { throw 'KeeMASH release-mode updater validation failed.' }
        & npm.cmd run package:win
        if ($LASTEXITCODE -ne 0) { throw 'KeeMASH NSIS packaging failed.' }
    }

    $bundleDir = Join-Path $desktopRoot 'src-tauri\target\release\bundle\nsis'
    $installer = Get-ChildItem -LiteralPath $bundleDir -File -Filter '*.exe' -ErrorAction Stop |
        Where-Object { $_.Name -like "*$version*" } |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if (-not $installer) {
        throw "No NSIS installer for version $version was found under $bundleDir"
    }

    $releaseRoot = Join-Path $desktopRoot 'release'
    $versionRoot = Join-Path $UpdateRoot $version
    New-Item -ItemType Directory -Force -Path $releaseRoot, $versionRoot | Out-Null

    $releaseInstaller = Join-Path $releaseRoot $installer.Name
    $publishedInstaller = Join-Path $versionRoot $installer.Name
    Copy-Item -LiteralPath $installer.FullName -Destination $releaseInstaller -Force
    Copy-Item -LiteralPath $installer.FullName -Destination $publishedInstaller -Force

    $publishedFile = Get-Item -LiteralPath $publishedInstaller
    $stream = [System.IO.File]::OpenRead($publishedInstaller)
    try {
        $algorithm = [System.Security.Cryptography.SHA256]::Create()
        try {
            $sha256 = ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        }
        finally {
            $algorithm.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
    $manifest = [ordered]@{
        schemaVersion = 1
        version = $version
        publishedAt = [DateTime]::UtcNow.ToString('o')
        installer = "$version/$($installer.Name)"
        sha256 = $sha256
        bytes = $publishedFile.Length
    }
    $manifestJson = $manifest | ConvertTo-Json

    foreach ($destination in @(
        (Join-Path $UpdateRoot 'latest.json')
        (Join-Path $releaseRoot 'latest.json')
    )) {
        $temporary = "$destination.tmp"
        [System.IO.File]::WriteAllText($temporary, $manifestJson, [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $destination -Force
    }

    [pscustomobject]@{
        Version = $version
        Installer = $releaseInstaller
        UpdateRoot = $UpdateRoot
        PublishedInstaller = $publishedInstaller
        Sha256 = $sha256
        Bytes = $publishedFile.Length
        Status = 'PASS'
    }
}
finally {
    Pop-Location
}
