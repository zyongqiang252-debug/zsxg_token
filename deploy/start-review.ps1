$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot
$binary = Join-Path $repo '..\zsxg_token-env\bin\zsxg-token-review.exe'
if (-not (Test-Path -LiteralPath $binary)) { throw 'Build zsxg-token-review.exe first.' }
$env:REVIEW_GATEWAY_BINARY = (Resolve-Path -LiteralPath $binary).Path
$env:REVIEW_SERVE = '1'
$env:PYTHONIOENCODING = 'utf-8'
Push-Location -LiteralPath $repo
try {
    python -m unittest discover -s deploy -p test_integration.py -v
    if ($LASTEXITCODE -ne 0) { throw 'Local review validation failed; see the test output.' }
} finally {
    Pop-Location
    Remove-Item Env:REVIEW_SERVE -ErrorAction SilentlyContinue
}
