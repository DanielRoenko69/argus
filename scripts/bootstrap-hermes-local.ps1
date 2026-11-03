param(
  [string]$HermesRepository = (Join-Path $PSScriptRoot '..\packs\argus-hermes'),
  [switch]$SkipBuild,
  [switch]$PreserveNativeHermesTools
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $ProjectDir

function New-HexSecretFile([string]$Path, [int]$Bytes = 32) {
  if (Test-Path -LiteralPath $Path) { return }
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  $value = ([BitConverter]::ToString($buffer) -replace '-', '').ToLowerInvariant()
  [System.IO.File]::WriteAllText($Path, $value + [Environment]::NewLine)
}

function Set-DotEnvValue([string]$Key, [string]$Value) {
  if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
  }
  $lines = [System.Collections.Generic.List[string]](Get-Content -LiteralPath '.env')
  $replaced = $false
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match ('^' + [regex]::Escape($Key) + '=')) {
      $lines[$index] = "$Key=$Value"
      $replaced = $true
    }
  }
  if (-not $replaced) { $lines.Add("$Key=$Value") }
  Set-Content -LiteralPath '.env' -Value $lines -Encoding utf8
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker Desktop is required and must be available in PATH.'
}
if (-not (Test-Path -LiteralPath $HermesRepository)) {
  throw "argus.hermes repository not found: $HermesRepository"
}

$discoverySecret = Join-Path $ProjectDir 'secrets\argus-hermes-discovery-token'
$apiSecret = Join-Path $ProjectDir 'secrets\hermes-api-key'
New-HexSecretFile $discoverySecret
New-HexSecretFile $apiSecret
Set-DotEnvValue 'ARGUS_HERMES_DISCOVERY_TOKEN_FILE' './secrets/argus-hermes-discovery-token'
Set-DotEnvValue 'ARGUS_HERMES_API_KEY_SOURCE_FILE' './secrets/hermes-api-key'
Set-DotEnvValue 'ARGUS_HERMES_IMAGE' 'argus-hermes:local'

if (-not $SkipBuild) {
  Write-Host '[hermes] Building the argus-hermes Pack from packs/...'
  & docker build -t argus-hermes:local $HermesRepository
  if ($LASTEXITCODE -ne 0) { throw 'argus.hermes image build failed.' }
}

$compose = @(
  'compose',
  '-f', 'docker-compose.yml',
  '-f', 'compose.external-pack.yml',
  '-f', 'compose.hermes-attached.yml',
  '-f', 'compose.hermes-local.yml'
)

Write-Host '[hermes] Starting Core, the runtime Pack and the provider-neutral Hermes upstream...'
& docker @compose up -d --build --wait mcp-server hermes-upstream argus-hermes
if ($LASTEXITCODE -ne 0) { throw 'Attached Hermes stack startup failed.' }

if (-not $PreserveNativeHermesTools) {
  Write-Host '[hermes] Applying the safe attached-mode default: no Hermes-native API tools...'
  & docker @compose exec -T hermes-upstream hermes config set platform_toolsets.api_server '[]'
  if ($LASTEXITCODE -ne 0) { throw 'Unable to apply the local Hermes no-tool profile.' }

  # The official image reads this profile while constructing the API-server
  # agent. Restart both sides so the first certification run cannot inherit a
  # previously initialized native-tool catalog.
  & docker @compose restart hermes-upstream argus-hermes
  if ($LASTEXITCODE -ne 0) { throw 'Unable to restart the attached Hermes services.' }
  & docker @compose up -d --wait hermes-upstream argus-hermes
  if ($LASTEXITCODE -ne 0) { throw 'Attached Hermes services did not recover after applying the no-tool profile.' }
}

& docker @compose ps mcp-server hermes-upstream argus-hermes
Write-Host '[hermes] Infrastructure is ready. Hermes still owns its provider authentication.'
if ($PreserveNativeHermesTools) {
  Write-Host '[hermes] Existing Hermes-native API tool configuration was preserved (external governance boundary).'
} else {
  Write-Host '[hermes] Hermes-native API tools are disabled for the attached-mode certification profile.'
}
Write-Host '[hermes] Add a Codex subscription with:'
Write-Host '  docker compose -f docker-compose.yml -f compose.external-pack.yml -f compose.hermes-attached.yml -f compose.hermes-local.yml exec hermes-upstream hermes auth add openai-codex --type oauth --no-browser'
Write-Host '[hermes] Then select its default model with:'
Write-Host '  docker compose -f docker-compose.yml -f compose.external-pack.yml -f compose.hermes-attached.yml -f compose.hermes-local.yml exec hermes-upstream hermes model --no-browser'
