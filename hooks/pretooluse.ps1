$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd()

if (-not (Get-Command helmion -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine(
        'HELMION BLOCKED: the governance CLI is not available on PATH. Run npm link in the Helmion repository.'
    )
    exit 2
}

try {
    $payload | & helmion guard
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine("HELMION BLOCKED: the governance hook failed: $($_.Exception.Message)")
    exit 2
}
