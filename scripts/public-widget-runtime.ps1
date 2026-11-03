param(
  [Parameter(Position = 0)]
  [ValidateSet('enable', 'disable')]
  [string]$Mode = 'enable',
  [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DotEnvPath = Join-Path $ProjectDir '.env'
Set-Location $ProjectDir

if (-not (Test-Path -LiteralPath $DotEnvPath)) {
  throw 'No .env file found. Run the local bootstrap first.'
}

$enabled = if ($Mode -eq 'enable') { 'true' } else { 'false' }
$lines = [System.Collections.Generic.List[string]](Get-Content -LiteralPath $DotEnvPath)
$replaced = $false
for ($index = 0; $index -lt $lines.Count; $index++) {
  if ($lines[$index] -match '^PUBLIC_WIDGET_ENABLED=') {
    $lines[$index] = "PUBLIC_WIDGET_ENABLED=$enabled"
    $replaced = $true
  }
}
if (-not $replaced) { $lines.Add("PUBLIC_WIDGET_ENABLED=$enabled") }
Set-Content -LiteralPath $DotEnvPath -Value $lines -Encoding utf8

Write-Host "[public-widget] PUBLIC_WIDGET_ENABLED=$enabled"
if ($NoRestart) { return }

& docker compose up -d --force-recreate --no-deps mcp-server
if ($LASTEXITCODE -ne 0) { throw 'Argus Core restart failed.' }

$deadline = (Get-Date).AddSeconds(60)
do {
  $health = [string](& docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' argus-core-mcp-server-1)
  if ($health.Trim() -eq 'healthy') {
    Write-Host "[public-widget] Argus Core is healthy. Runtime is $Mode`d."
    return
  }
  Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)

throw "Argus Core did not become healthy within 60 seconds (last state: $health)."
