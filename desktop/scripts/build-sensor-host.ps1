[CmdletBinding()]
param(
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$desktopRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$tauriRoot = Join-Path $desktopRoot 'src-tauri'
$source = Join-Path $tauriRoot 'sensor-host\Program.cs'
$vendor = Join-Path $tauriRoot 'vendor\librehardwaremonitor'
$lhm = Join-Path $vendor 'LibreHardwareMonitorLib.dll'
$spd = Join-Path $vendor 'RAMSPDToolkit-NDD.dll'
$output = Join-Path $vendor 'KeeMashSensorHost.exe'
$hashFile = Join-Path $vendor 'KeeMashSensorHost.source.sha256'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

foreach ($required in @($source, $lhm, $spd, $csc)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required sensor-host input was not found: $required"
    }
}

$sourceHash = ''
foreach ($line in & (Join-Path $env:WINDIR 'System32\certutil.exe') -hashfile $source SHA256) {
    $candidate = $line.Replace(' ', '').Trim()
    if ($candidate -match '^[0-9a-fA-F]{64}$') {
        $sourceHash = $candidate.ToLowerInvariant()
    }
}
if (-not $sourceHash) { throw 'Unable to calculate the sensor-host source hash.' }
$recordedHash = if (Test-Path -LiteralPath $hashFile) {
    (Get-Content -LiteralPath $hashFile -Raw).Trim().ToLowerInvariant()
} else {
    ''
}
if (-not $Force -and (Test-Path -LiteralPath $output) -and $recordedHash -eq $sourceHash) {
    Write-Host "KeeMASH sensor host is current ($sourceHash)."
    return
}

& $csc /nologo /target:exe /optimize+ /platform:x64 "/out:$output" "/reference:$lhm" "/reference:$spd" /reference:System.Management.dll /reference:System.Web.Extensions.dll $source
if ($LASTEXITCODE -ne 0) {
    throw "Sensor host compilation failed with exit code $LASTEXITCODE"
}
Set-Content -LiteralPath $hashFile -Value $sourceHash -Encoding ascii -NoNewline
Write-Host "Built $output"
