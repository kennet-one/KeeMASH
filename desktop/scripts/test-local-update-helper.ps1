[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$desktopRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $desktopRoot 'src-tauri\Cargo.toml'
$libPath = Join-Path $desktopRoot 'src-tauri\src\lib.rs'

if (Select-String -LiteralPath $libPath -SimpleMatch 'app.exit(0)' -Quiet) {
    throw 'Regression: updater must not call app.exit(0) from the IPC command.'
}

& cargo test --release --lib --manifest-path $manifestPath 'local_updater::tests::' -- '--test-threads=1'
if ($LASTEXITCODE -ne 0) {
    throw "Release-mode updater tests failed with exit code $LASTEXITCODE"
}

[pscustomobject]@{
    Manifest = $manifestPath
    Mode = 'release'
    ForbiddenIpcExit = 'absent'
    Status = 'PASS'
}
