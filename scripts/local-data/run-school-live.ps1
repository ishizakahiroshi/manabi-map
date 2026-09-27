# Explicit private configuration only. Canonical helper values go to Python stdin,
# never argv, inherited credential environment, diagnostics, or public output.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Config,
    [ValidateSet('list', 'run-one', 'reject', 'batch')][string]$Command = 'list',
    [string]$RequestId,
    [ValidateRange(1, 100)][int]$Limit = 25,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$helper = $null
$pgValues = @{}
$publisherValues = @{}
$stdinText = $null

function Invoke-BoundedPython {
    param([string]$Executable, [string[]]$Arguments, [string]$InputText, [int]$TimeoutSeconds)
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
    $start.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $start.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $start.Environment.Clear()
    foreach ($key in @('SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH')) {
        $entry = [Environment]::GetEnvironmentVariable($key)
        if ($null -ne $entry) { $start.Environment[$key] = $entry }
    }
    $start.Environment['PYTHONUTF8'] = '1'
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        if (-not $process.Start()) { throw 'child start failed' }
        $outBuffer = [char[]]::new(4096)
        $errBuffer = [char[]]::new(4096)
        $outTask = $process.StandardOutput.ReadAsync($outBuffer, 0, $outBuffer.Length)
        $errTask = $process.StandardError.ReadAsync($errBuffer, 0, $errBuffer.Length)
        $writeTask = $process.StandardInput.WriteAsync($InputText)
        $inputClosed = $false
        $outDone = $false
        $errDone = $false
        $errorCount = 0
        $output = [System.Text.StringBuilder]::new()
        while (-not ($process.HasExited -and $outDone -and $errDone)) {
            if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw 'child deadline exceeded' }
            if (-not $inputClosed -and $writeTask.IsCompleted) {
                [void]$writeTask.GetAwaiter().GetResult()
                $process.StandardInput.Close()
                $inputClosed = $true
            }
            if (-not $outDone -and $outTask.IsCompleted) {
                $count = $outTask.GetAwaiter().GetResult()
                if ($count -eq 0) { $outDone = $true }
                else {
                    if ($output.Length + $count -gt 131072) { throw 'child output limit exceeded' }
                    [void]$output.Append($outBuffer, 0, $count)
                    $outTask = $process.StandardOutput.ReadAsync($outBuffer, 0, $outBuffer.Length)
                }
            }
            if (-not $errDone -and $errTask.IsCompleted) {
                $count = $errTask.GetAwaiter().GetResult()
                if ($count -eq 0) { $errDone = $true }
                else {
                    $errorCount += $count
                    if ($errorCount -gt 131072) { throw 'child diagnostic limit exceeded' }
                    $errTask = $process.StandardError.ReadAsync($errBuffer, 0, $errBuffer.Length)
                }
            }
            Start-Sleep -Milliseconds 20
        }
        if ($process.ExitCode -ne 0) { throw 'child failed' }
        return $output.ToString()
    }
    finally {
        if ($process.Id -and -not $process.HasExited) {
            $process.Kill($true)
            if (-not $process.WaitForExit(5000)) { throw 'child termination not confirmed' }
        }
        $process.Dispose()
    }
}

function Get-RegisteredValue {
    param($Reference, [string]$Name)
    # One allowlisted registered key per invocation; helper is the only parser.
    $value = & $helper -File $Reference.file -Section $Reference.section -Raw $Reference.keys[$Name] 2>$null 3>$null 4>$null 5>$null 6>$null
    if (-not $? -or $value -isnot [string] -or $value.Length -eq 0 -or $value.Length -gt 16384 -or $value.Contains([char]0) -or $value.Contains("`n") -or $value.Contains("`r")) {
        throw 'registered value unavailable'
    }
    return $value
}

try {
    $configPath = [IO.Path]::GetFullPath($Config)
    $configStream = [IO.File]::OpenRead($configPath)
    try {
        if ($configStream.Length -gt 65536) { throw 'configuration limit exceeded' }
        $configBuffer = [byte[]]::new(65537)
        $configCount = 0
        while ($configCount -lt $configBuffer.Length) {
            $read = $configStream.Read($configBuffer, $configCount, $configBuffer.Length - $configCount)
            if ($read -eq 0) { break }
            $configCount += $read
        }
        if ($configCount -eq 0 -or $configCount -gt 65536) { throw 'configuration limit exceeded' }
        $configBytes = [byte[]]::new($configCount)
        [Array]::Copy($configBuffer, $configBytes, $configCount)
    }
    finally { $configStream.Dispose() }
    $configPin = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($configBytes)).ToLowerInvariant()
    $settings = [Text.Encoding]::UTF8.GetString($configBytes) | ConvertFrom-Json -AsHashtable
    $runner = Join-Path $PSScriptRoot 'school_live_runner.py'
    $common = @('-B', $runner, '--config', $configPath, '--config-sha256', $configPin)
    $validated = Invoke-BoundedPython -Executable $settings.python_executable -Arguments ($common + @('validate-config')) -InputText '' -TimeoutSeconds 30
    $validation = $validated | ConvertFrom-Json -AsHashtable
    if ($validation.status -ne 'ok' -or $validation.command -ne 'validate-config') { throw 'configuration rejected' }
    # The pinned owner configuration selects the canonical installed helper.
    # Python has checked its absolute local unaliased file path and basename.
    $helper = $settings.secret_helper
    if (($Command -in @('run-one', 'reject')) -ne (-not [string]::IsNullOrEmpty($RequestId))) { throw 'request scope required' }
    foreach ($key in @('PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD')) {
        $pgValues[$key] = Get-RegisteredValue -Reference $settings.pg_credentials -Name $key
    }
    $pgValues['PGSSLMODE'] = 'verify-full'
    $pgValues['PGSSLROOTCERT'] = $settings.pg_sslrootcert
    if ($Apply -and $Command -ne 'list' -and $settings.publisher_auth -eq 'explicit-token') {
        $publisherValues['CLOUDFLARE_API_TOKEN'] = Get-RegisteredValue -Reference $settings.publisher_credentials -Name 'CLOUDFLARE_API_TOKEN'
    }
    $stdinText = @{pg_environment = $pgValues; publisher_environment = $publisherValues} | ConvertTo-Json -Depth 6 -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($stdinText) -gt 65536) { throw 'credential transport limit exceeded' }
    $arguments = $common + @($Command, '--limit', [string]$Limit)
    if ($RequestId) { $arguments += @('--request-id', $RequestId) }
    if ($Apply) { $arguments += '--apply' }
    $resultText = Invoke-BoundedPython -Executable $settings.python_executable -Arguments $arguments -InputText $stdinText -TimeoutSeconds ($settings.timeout_seconds + 60)
    $result = $resultText | ConvertFrom-Json -AsHashtable
    if ($result.status -ne 'ok' -or $result.command -ne $Command -or $result.items.Count -gt 100 -or $result.count -ne $result.items.Count) { throw 'result rejected' }
    $safeItems = @($result.items | ForEach-Object {
        $identifier = [Guid]::Parse($_.id).ToString()
        if ($identifier -ne $_.id -or $_.kind -notin @('deviation', 'publish') -or $_.state -notin @('received', 'claimed', 'adopted', 'generated', 'publication_confirmed', 'blocked', 'rejected', 'dry-run', 'skipped')) { throw 'result rejected' }
        @{id = $identifier; kind = $_.kind; state = $_.state}
    })
    @{status = 'ok'; command = $Command; count = $safeItems.Count; items = $safeItems} | ConvertTo-Json -Depth 5 -Compress
    exit 0
}
catch {
    Write-Output '{"status":"failed","error":"school runner stopped; reconcile queued work and retained local state"}'
    exit 1
}
finally {
    $pgValues.Clear()
    $publisherValues.Clear()
    $stdinText = $null
}
