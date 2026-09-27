param(
    [Parameter(Mandatory)][string]$Config,
    [switch]$Apply,
    [switch]$Prune,
    [ValidateSet('all', 'school', 'supabase')][string]$Only = 'all'
)
$ErrorActionPreference = 'Stop'
$backupProcess = $null
$backupStarted = $false
$backupSecrets = @{}
try {
    $backupConfigPath = [IO.Path]::GetFullPath($Config)
    $backupConfig = [IO.File]::ReadAllText($backupConfigPath) | ConvertFrom-Json
    if (-not [IO.File]::Exists($backupConfig.python_executable)) { throw 'Python unavailable' }
    $backupInfo = [Diagnostics.ProcessStartInfo]::new()
    $backupInfo.FileName = $backupConfig.python_executable
    $backupInfo.UseShellExecute = $false
    $backupInfo.CreateNoWindow = $true
    $backupInfo.RedirectStandardInput = $true
    $backupInfo.RedirectStandardOutput = $true
    $backupInfo.RedirectStandardError = $true
    foreach ($item in @('-B', (Join-Path $PSScriptRoot 'backup_live.py'), '--config', $backupConfigPath, '--only', $Only)) {
        $backupInfo.ArgumentList.Add($item)
    }
    if ($Apply) { $backupInfo.ArgumentList.Add('--apply') }
    if ($Prune) { $backupInfo.ArgumentList.Add('--prune') }
    $backupSecrets = @{}
    if ($Apply) {
        if (-not [IO.File]::Exists($backupConfig.secret_helper)) { throw 'Secret helper unavailable' }
        $backupCheck = & $backupConfig.secret_helper -File $backupConfig.credential_file -Check
        if ($LASTEXITCODE -ne 0) { throw 'Credential file validation failed' }
        foreach ($key in @('R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')) {
            $value = & $backupConfig.secret_helper -File $backupConfig.credential_file -Raw $key
            if ([string]::IsNullOrWhiteSpace($value)) { throw 'Credential missing' }
            $backupSecrets[$key] = $value
        }
    }
    $backupProcess = [Diagnostics.Process]::new()
    $backupProcess.StartInfo = $backupInfo
    $null = $backupProcess.Start()
    $backupStarted = $true
    $backupOutputTask = $backupProcess.StandardOutput.ReadToEndAsync()
    $backupErrorTask = $backupProcess.StandardError.ReadToEndAsync()
    if ($Apply) { $backupProcess.StandardInput.Write(($backupSecrets | ConvertTo-Json -Compress)) }
    $backupProcess.StandardInput.Close()
    $backupSecrets.Clear()
    $value = $null
    if (-not $backupProcess.WaitForExit(600000)) {
        $backupProcess.Kill($true)
        throw 'Backup deadline exceeded'
    }
    $backupOutput = $backupOutputTask.GetAwaiter().GetResult()
    $null = $backupErrorTask.GetAwaiter().GetResult()
    # Python emits only its fixed receipt structure; do not print arbitrary stderr.
    $backupReceipt = $backupOutput | ConvertFrom-Json
    $backupReceipt | ConvertTo-Json -Depth 20 -Compress
    exit $backupProcess.ExitCode
} catch {
    Write-Output '{"status":"failed","error":"backup launcher failed; previous copies are retained"}'
    exit 1
} finally {
    $backupSecrets.Clear()
    $value = $null
    if ($backupProcess) {
        if ($backupStarted -and -not $backupProcess.HasExited) { $backupProcess.Kill($true) }
        $backupProcess.Dispose()
    }
}
