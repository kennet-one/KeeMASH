[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('check', 'cargo-test', 'dev', 'build')]
    [string]$Command
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$desktopRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$sensorHostBuilder = Join-Path $PSScriptRoot 'build-sensor-host.ps1'
& $sensorHostBuilder
if ($LASTEXITCODE -ne 0) { throw 'Sensor host build failed' }
$vsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vsWhere)) {
    throw 'Visual Studio Build Tools are required: vswhere.exe was not found.'
}

$visualStudioRoot = (& $vsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
if (-not $visualStudioRoot) {
    throw 'Visual C++ x64/x86 build tools are not installed.'
}
$vsDevCmd = Join-Path $visualStudioRoot 'Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path -LiteralPath $vsDevCmd)) {
    throw "VsDevCmd.bat was not found under $visualStudioRoot"
}

$environmentLines = & $env:COMSPEC /d /s /c "`"$vsDevCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
foreach ($line in $environmentLines) {
    $separator = $line.IndexOf('=')
    if ($separator -le 0) { continue }
    $name = $line.Substring(0, $separator)
    $value = $line.Substring($separator + 1)
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}

$rustRoot = Join-Path $env:USERPROFILE 'scoop\persist\rustup'
$env:CARGO_HOME = Join-Path $rustRoot '.cargo'
$env:RUSTUP_HOME = Join-Path $rustRoot '.rustup'
$cargoBin = Join-Path $env:CARGO_HOME 'bin'
$env:PATH = "$cargoBin;$env:PATH"
$cargo = Join-Path $cargoBin 'cargo.exe'
$tauri = Join-Path $desktopRoot 'node_modules\.bin\tauri.cmd'
if (-not (Test-Path -LiteralPath $cargo)) { throw 'cargo.exe was not found. Install rustup first.' }
if (-not (Test-Path -LiteralPath $tauri)) { throw 'Tauri CLI was not found. Run npm install first.' }

function Test-NsisBundle {
    $bundleDirectory = Join-Path $desktopRoot 'src-tauri\target\release\bundle\nsis'
    $installer = Get-ChildItem -LiteralPath $bundleDirectory -File -Filter '*.exe' -ErrorAction Stop |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if (-not $installer) {
        throw "No NSIS installer was found under $bundleDirectory"
    }

    $sevenZip = Get-Command '7z.exe' -ErrorAction SilentlyContinue
    if (-not $sevenZip) {
        throw '7-Zip is required to verify the NSIS bundle integrity.'
    }

    $testOutput = & $sevenZip.Source t -bso0 -bsp0 $installer.FullName 2>&1
    if ($LASTEXITCODE -ne 0) {
        $details = ($testOutput | Out-String).Trim()
        throw "NSIS integrity validation failed for $($installer.FullName):`n$details"
    }

    $stream = [System.IO.File]::OpenRead($installer.FullName)
    try {
        $algorithm = [System.Security.Cryptography.SHA256]::Create()
        try {
            $hash = ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
        }
        finally {
            $algorithm.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
    Write-Host "NSIS integrity PASS: $($installer.Name) ($($installer.Length) bytes, SHA256 $hash)"
}

Push-Location $desktopRoot
try {
    switch ($Command) {
        'check' {
            & $cargo fmt --manifest-path 'src-tauri\Cargo.toml' -- --check
            if ($LASTEXITCODE -ne 0) { throw 'cargo fmt check failed' }
            & $cargo clippy --manifest-path 'src-tauri\Cargo.toml' --all-targets -- -D warnings
            if ($LASTEXITCODE -ne 0) { throw 'cargo clippy failed' }
            & $cargo test --manifest-path 'src-tauri\Cargo.toml'
        }
        'cargo-test' { & $cargo test --manifest-path 'src-tauri\Cargo.toml' }
        'dev' { & $tauri dev }
        'build' {
            & $tauri build
            if ($LASTEXITCODE -eq 0) { Test-NsisBundle }
        }
    }
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
}
