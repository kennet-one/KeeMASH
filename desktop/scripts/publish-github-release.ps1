[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Repository = 'kennet-one/KeeMASH',
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$desktopRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $desktopRoot '..')).Path
$packagePath = Join-Path $desktopRoot 'package.json'
$package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
$version = [string]$package.version
$tag = "v$version"
$releaseRoot = Join-Path $desktopRoot 'release'
$manifestPath = Join-Path $releaseRoot 'latest.json'
$installerPath = Join-Path $releaseRoot "KeeMASH_${version}_x64-setup.exe"

if (-not $version) { throw 'package.json has no version.' }
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Signed release manifest is missing: $manifestPath"
}
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "Release installer is missing: $installerPath"
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ([string]$manifest.version -ne $version) {
    throw "Release manifest version $($manifest.version) does not match package version $version."
}
if ([string]$manifest.installer -ne "$version/$(Split-Path -Leaf $installerPath)") {
    throw 'Release manifest installer path does not match the expected GitHub asset.'
}
$installer = Get-Item -LiteralPath $installerPath
if ([int64]$manifest.bytes -ne $installer.Length) {
    throw 'Release installer size does not match the signed manifest.'
}
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$installerStream = $null
try {
    $installerStream = [System.IO.File]::OpenRead($installerPath)
    $hashBytes = $sha256.ComputeHash($installerStream)
}
finally {
    if ($null -ne $installerStream) {
        $installerStream.Dispose()
    }
    $sha256.Dispose()
}
$actualHash = ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
if ($actualHash -ne ([string]$manifest.sha256).ToLowerInvariant()) {
    throw 'Release installer SHA-256 does not match the signed manifest.'
}

$dirty = & git -C $repositoryRoot status --porcelain
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the KeeMASH Git worktree.' }
if ($dirty) { throw 'Commit and review the KeeMASH worktree before publishing a GitHub release.' }

$branch = (& git -C $repositoryRoot branch --show-current).Trim()
$head = (& git -C $repositoryRoot rev-parse HEAD).Trim()
$upstream = (& git -C $repositoryRoot rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null).Trim()
if (-not $upstream) { throw 'The current branch has no upstream.' }
$upstreamHead = (& git -C $repositoryRoot rev-parse $upstream).Trim()
if ($head -ne $upstreamHead) { throw "HEAD is not published to $upstream." }

& gh auth status | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI authentication is unavailable.' }

$result = [pscustomobject]@{
    Repository = $Repository
    Branch = $branch
    Tag = $tag
    Version = $version
    Installer = $installerPath
    Manifest = $manifestPath
    Sha256 = $actualHash
    Bytes = $installer.Length
    Applied = [bool]$Apply
}
if (-not $Apply) {
    $result
    return
}

if (-not $PSCmdlet.ShouldProcess("$Repository $tag", 'Publish signed KeeMASH GitHub release')) {
    $result
    return
}

$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & gh release view $tag --repo $Repository *> $null
    $releaseExists = $LASTEXITCODE -eq 0
}
finally {
    $ErrorActionPreference = $previousErrorAction
}
if ($releaseExists) {
    & gh release upload $tag $installerPath $manifestPath --repo $Repository --clobber
} else {
    & gh release create $tag $installerPath $manifestPath --repo $Repository `
        --title "KeeMASH $version" `
        --notes "Signed stable KeeMASH Desktop release. The in-app updater verifies the Ed25519 manifest, installer size, and SHA-256 before installation."
}
if ($LASTEXITCODE -ne 0) { throw 'GitHub release publication failed.' }

& gh release edit $tag --repo $Repository --latest
if ($LASTEXITCODE -ne 0) {
    throw 'GitHub release was published but could not be marked as Latest.'
}

$result
