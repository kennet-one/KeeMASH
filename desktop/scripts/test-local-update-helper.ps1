[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$desktopRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $desktopRoot 'src-tauri\Cargo.toml'
$libPath = Join-Path $desktopRoot 'src-tauri\src\lib.rs'

$libSource = Get-Content -Raw -LiteralPath $libPath
$installFunction = [regex]::Match(
    $libSource,
    '(?s)fn local_update_install\b.*?\r?\n}\r?\n\r?\nfn require_native_confirmation\b'
)
if (-not $installFunction.Success) {
    throw 'Regression: local_update_install could not be isolated for IPC exit validation.'
}
if ($installFunction.Value.Contains('app.exit(0)')) {
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
