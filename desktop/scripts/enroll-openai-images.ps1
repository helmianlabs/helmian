param(
    [string]$ServicePath
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($ServicePath)) {
    $candidates = @(
        (Join-Path $repositoryRoot 'artifacts\Helmion-Pilot-win-x64-self-contained\Helmion Local Service.exe'),
        (Join-Path $repositoryRoot 'desktop\Helmion.LocalService\bin\Release\net10.0-windows\Helmion Local Service.dll'),
        (Join-Path $repositoryRoot 'desktop\Helmion.LocalService\bin\Debug\net10.0-windows\Helmion Local Service.dll')
    )
    $ServicePath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if ([string]::IsNullOrWhiteSpace($ServicePath) -or -not (Test-Path -LiteralPath $ServicePath)) {
    throw 'Build Helmion Local Service first, then rerun this one-time enrollment command.'
}

$secret = Read-Host 'OpenAI API key (stored with Windows CurrentUser DPAPI; input is hidden)' -AsSecureString
$start = [System.Diagnostics.ProcessStartInfo]::new()
if ([IO.Path]::GetExtension($ServicePath) -ieq '.dll') {
    $start.FileName = 'dotnet'
    [void]$start.ArgumentList.Add((Resolve-Path -LiteralPath $ServicePath).Path)
} else {
    $start.FileName = (Resolve-Path -LiteralPath $ServicePath).Path
}
# Windows PowerShell 5 does not expose ProcessStartInfo.ArgumentList. Use the
# compatible Arguments property so one-time enrollment works on the desktop.
$start.Arguments = '--enroll-openai-images-from-stdin'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true

$process = [System.Diagnostics.Process]::Start($start)
if ($null -eq $process) {
    throw 'Could not start Helmion Local Service credential enrollment.'
}

$pointer = [IntPtr]::Zero
$exitCode = -1
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $length = [Runtime.InteropServices.Marshal]::ReadInt32($pointer, -4) / 2
    for ($index = 0; $index -lt $length; $index += 1) {
        $character = [char][Runtime.InteropServices.Marshal]::ReadInt16($pointer, $index * 2)
        $process.StandardInput.Write($character)
    }
    $process.StandardInput.WriteLine()
    $process.StandardInput.Close()
    $process.WaitForExit()
    $exitCode = $process.ExitCode
} finally {
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    $secret.Dispose()
    $process.Dispose()
}

if ($exitCode -ne 0) {
    throw 'OpenAI Images credential enrollment was rejected. Confirm the API key and try again.'
}
Write-Host 'OpenAI Images credential enrolled for the current Windows user. Restart Helmion if it is already open.'
