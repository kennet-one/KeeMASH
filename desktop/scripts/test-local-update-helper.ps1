[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$desktopRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $desktopRoot 'src-tauri\Cargo.toml'
$libPath = Join-Path $desktopRoot 'src-tauri\src\lib.rs'
$mainPath = Join-Path $desktopRoot 'src-tauri\src\main.rs'
$updaterPath = Join-Path $desktopRoot 'src-tauri\src\local_updater.rs'

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

$updaterSource = Get-Content -Raw -LiteralPath $updaterPath
$launchFunction = [regex]::Match(
    $updaterSource,
    '(?s)pub fn launch_update_helper\b.*?\r?\n}\r?\n\r?\nfn stage_verified_helper\b'
)
if (-not $launchFunction.Success) {
    throw 'Regression: launch_update_helper could not be isolated for helper-path validation.'
}
if ($launchFunction.Value.Contains('Command::new(&installed_exe)')) {
    throw 'Regression: updater helper must not execute from the installed target binary.'
}
if (-not $launchFunction.Value.Contains('Command::new(&staged_helper)')) {
    throw 'Regression: updater helper must execute from its protected staged copy.'
}
if (-not $launchFunction.Value.Contains('helper.ready')) {
    throw 'Regression: updater must wait for the helper readiness handshake.'
}
if (-not $updaterSource.Contains('relaunch_installed_after_failure()')) {
    throw 'Regression: post-exit updater failures must relaunch the installed application.'
}
if ($updaterSource.Contains('[0_u8; 1024 * 1024]')) {
    throw 'Regression: updater hashing must not reserve a 1 MiB buffer on the Windows thread stack.'
}
if (-not $updaterSource.Contains('.stack_size(HELPER_THREAD_STACK_BYTES)')) {
    throw 'Regression: updater helper logic must run on a worker with an explicit stack reserve.'
}
$mainSource = Get-Content -Raw -LiteralPath $mainPath
if (-not $mainSource.Contains('schedule_update_cleanup()')) {
    throw 'Regression: successful updates must schedule bounded staged-helper cleanup.'
}

& cargo test --release --lib --manifest-path $manifestPath 'local_updater::tests::' -- '--test-threads=1'
if ($LASTEXITCODE -ne 0) {
    throw "Release-mode updater tests failed with exit code $LASTEXITCODE"
}

[pscustomobject]@{
    Manifest = $manifestPath
    Mode = 'release'
    ForbiddenIpcExit = 'absent'
    InstalledExeSelfLock = 'absent'
    HelperReadinessHandshake = 'present'
    HeapHashBuffers = 'present'
    ExplicitHelperStack = 'present'
    FailureRelaunch = 'present'
    Status = 'PASS'
}
