param(
    [Parameter(Mandatory)][string]$Apk,
    [Parameter(Mandatory)][string]$Aapt
)
$ErrorActionPreference = 'Stop'
$manifestLines = @(& $Aapt dump xmltree $Apk AndroidManifest.xml)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the APK manifest' }
$manifest = $manifestLines -join "`n"
$activityBlocks = [regex]::Matches($manifest, '(?ms)^      E: activity \([^\n]*\n.*?(?=^      E:|\z)')
$requiredActivities = @(
    'com.google.androidbrowserhelper.trusted.LauncherActivity',
    'com.google.androidbrowserhelper.trusted.ManageDataLauncherActivity'
)
foreach ($activity in $requiredActivities) {
    $namePattern = '(?m)^        A: android:name\([^\n]*="' + [regex]::Escape($activity) + '"'
    $declared = @($activityBlocks | Where-Object { $_.Value -match $namePattern })
    if ($declared.Count -ne 1) { throw ('Required launch component missing or duplicated: ' + $activity) }
}
$pilot = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../pilot.json') -Raw | ConvertFrom-Json
$badging = @(& $Aapt dump badging $Apk)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the APK identity' }
if (-not ($badging[0].Contains("name='$($pilot.applicationId)'"))) { throw 'Unexpected APK package' }
if (-not $manifest.Contains('="' + $pilot.startUrl + '"')) { throw 'Unexpected APK launch URL' }
Write-Output 'APK launch components, package and URL verified'
Write-Output $badging[0]
