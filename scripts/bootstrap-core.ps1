param(
  [switch]$NoBuild,
  [ValidateRange(60, 900)]
  [int]$WaitTimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $ProjectDir

function New-HexSecret([int]$Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buffer)
  }
  finally {
    $rng.Dispose()
  }
  return ([BitConverter]::ToString($buffer) -replace '-', '').ToLowerInvariant()
}

function Get-DotEnvValue([string]$Key) {
  $match = Get-Content -LiteralPath '.env' |
    Where-Object { $_ -match ('^' + [regex]::Escape($Key) + '=') } |
    Select-Object -Last 1
  if ($null -eq $match) { return '' }
  return $match.Substring($Key.Length + 1)
}

function Set-DotEnvValue([string]$Key, [string]$Value) {
  $lines = [System.Collections.Generic.List[string]](Get-Content -LiteralPath '.env')
  $replaced = $false
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match ('^' + [regex]::Escape($Key) + '=')) {
      $lines[$index] = "$Key=$Value"
      $replaced = $true
    }
  }
  if (-not $replaced) {
    $lines.Add("$Key=$Value")
  }
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines((Join-Path $ProjectDir '.env'), $lines, $utf8WithoutBom)
}

function Ensure-DotEnvSecret(
  [string]$Key,
  [string[]]$Placeholders,
  [string]$Prefix = '',
  [int]$Bytes = 32
) {
  $current = Get-DotEnvValue $Key
  if ([string]::IsNullOrWhiteSpace($current) -or $Placeholders -contains $current) {
    Set-DotEnvValue $Key ($Prefix + (New-HexSecret $Bytes))
  }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker Desktop with Compose v2 is required and must be available in PATH.'
}

& cmd.exe /d /c 'docker info >nul 2>&1'
if ($LASTEXITCODE -ne 0) {
  throw 'Docker Desktop is installed, but the Docker daemon is not running.'
}

if (-not (Test-Path -LiteralPath '.env')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env'
  Write-Host '[bootstrap-core] Created .env from .env.example.'
}

Ensure-DotEnvSecret 'MCP_API_KEYS' @('your-secret-api-key-here') 'ak_' 32
Ensure-DotEnvSecret 'SESSION_SECRET' @('CHANGE_ME_SESSION_SECRET') '' 32
Ensure-DotEnvSecret 'DB_ENCRYPTION_KEY' @('CHANGE_ME_DB_ENCRYPTION_KEY') '' 32
Ensure-DotEnvSecret 'POSTGRES_PASSWORD' @('CHANGE_ME') '' 16
Ensure-DotEnvSecret 'REDIS_PASSWORD' @('CHANGE_ME') '' 24
Ensure-DotEnvSecret 'WORKSPACE_SECRET' @('CHANGE_ME_WORKSPACE_SECRET') '' 32
Ensure-DotEnvSecret 'ARGUS_EXECUTION_GRANT_SECRET' @('CHANGE_ME_EXECUTION_GRANT_SECRET') '' 32
Ensure-DotEnvSecret 'ARGUS_WEBHOOK_SECRET' @('CHANGE_ME_WEBHOOK_SECRET') '' 32

$postgresUser = Get-DotEnvValue 'POSTGRES_USER'
if ([string]::IsNullOrWhiteSpace($postgresUser)) { $postgresUser = 'aiops' }
$postgresDatabase = Get-DotEnvValue 'POSTGRES_DB'
if ([string]::IsNullOrWhiteSpace($postgresDatabase)) { $postgresDatabase = 'aiops' }
$postgresPassword = Get-DotEnvValue 'POSTGRES_PASSWORD'
Set-DotEnvValue 'POSTGRES_CONNECTION_URL' "postgresql://${postgresUser}:${postgresPassword}@localhost:5432/${postgresDatabase}"

$composeArguments = @('compose', 'up', '-d', '--wait', '--wait-timeout', [string]$WaitTimeoutSeconds)
if (-not $NoBuild) {
  $composeArguments += '--build'
}
$composeArguments += 'mcp-server'

Write-Host '[bootstrap-core] Starting Argus Core, PostgreSQL and Redis only...'
& docker @composeArguments
if ($LASTEXITCODE -ne 0) {
  Write-Host '[bootstrap-core] Startup did not become healthy. Current service state:' -ForegroundColor Red
  & docker compose ps mcp-server postgres redis
  Write-Host '[bootstrap-core] Last Argus Core log lines:' -ForegroundColor Yellow
  & docker compose logs --no-color --tail 200 mcp-server
  throw 'Argus Core startup failed.'
}

& docker compose ps mcp-server postgres redis
if ($LASTEXITCODE -ne 0) {
  throw 'Unable to read the Argus Core service state.'
}

Write-Host '[bootstrap-core] Argus Console: http://localhost:3000'
Write-Host '[bootstrap-core] Health endpoint: http://localhost:3000/health'
