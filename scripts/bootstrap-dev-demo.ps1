param(
  [string]$ArgusUser = '',
  [switch]$SkipCoreBuild,
  [switch]$SkipSampleImageBuild
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $ProjectDir

function New-HexSecret([int]$Bytes = 24) {
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return ([BitConverter]::ToString($buffer) -replace '-', '').ToLowerInvariant()
}

function Get-DotEnvValue([string]$Key) {
  $match = [System.IO.File]::ReadAllLines((Resolve-Path '.env')) |
    Where-Object { $_ -match ('^' + [regex]::Escape($Key) + '=') } |
    Select-Object -Last 1
  if ($null -eq $match) { return '' }
  return $match.Substring($Key.Length + 1)
}

function Set-DotEnvValue([string]$Key, [string]$Value) {
  $envPath = (Resolve-Path '.env').Path
  $lines = [System.Collections.Generic.List[string]]([System.IO.File]::ReadAllLines($envPath))
  $replaced = $false
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match ('^' + [regex]::Escape($Key) + '=')) {
      $lines[$index] = "$Key=$Value"
      $replaced = $true
    }
  }
  if (-not $replaced) { $lines.Add("$Key=$Value") }
  [System.IO.File]::WriteAllLines($envPath, $lines, [System.Text.UTF8Encoding]::new($false))
}

function Wait-ForHttp([string]$Url, [int]$TimeoutSeconds = 120) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      Invoke-RestMethod -Uri $Url -TimeoutSec 3 | Out-Null
      return
    }
    catch {
      Start-Sleep -Seconds 2
    }
  } while ((Get-Date) -lt $deadline)
  throw "Service did not become ready: $Url"
}

function Test-GiteaToken([string]$Url, [string]$Token) {
  if ([string]::IsNullOrWhiteSpace($Token)) { return $false }
  try {
    Invoke-RestMethod -Uri "$Url/api/v1/user" -Headers @{ Authorization = "token $Token" } -TimeoutSec 5 | Out-Null
    return $true
  }
  catch { return $false }
}

if (-not (Test-Path -LiteralPath '.env')) {
  throw 'Missing .env. Run scripts/bootstrap-local.ps1 first so the Argus Core secrets and services exist.'
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker Desktop is required and must be available in PATH.'
}
& cmd.exe /d /c 'docker info >nul 2>&1'
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is installed but the Docker daemon is not running.' }

$giteaPort = Get-DotEnvValue 'GITEA_PORT'
if ($giteaPort -notmatch '^\d+$') { $giteaPort = '3005'; Set-DotEnvValue 'GITEA_PORT' $giteaPort }
$giteaUsername = Get-DotEnvValue 'GITEA_USERNAME'
if ([string]::IsNullOrWhiteSpace($giteaUsername)) { $giteaUsername = 'argus'; Set-DotEnvValue 'GITEA_USERNAME' $giteaUsername }
$giteaPassword = Get-DotEnvValue 'GITEA_PASSWORD'
if ($giteaPassword.Length -lt 16) { $giteaPassword = New-HexSecret 20; Set-DotEnvValue 'GITEA_PASSWORD' $giteaPassword }
$runnerToken = Get-DotEnvValue 'GITEA_RUNNER_REGISTRATION_TOKEN'
if ($runnerToken.Length -lt 32) { $runnerToken = New-HexSecret 24; Set-DotEnvValue 'GITEA_RUNNER_REGISTRATION_TOKEN' $runnerToken }

Set-DotEnvValue 'GITEA_BASE_URL' 'http://gitea:3000'
Set-DotEnvValue 'GITEA_OWNER' $giteaUsername
Set-DotEnvValue 'GITEA_REPO' 'argus-dev-sample'
if (-not [string]::IsNullOrWhiteSpace($ArgusUser)) { Set-DotEnvValue 'ARGUS_DEV_DEMO_USER' $ArgusUser }
$ssrfHosts = @((Get-DotEnvValue 'SSRF_ALLOWLIST_HOSTS') -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($ssrfHosts -notcontains 'gitea') { $ssrfHosts += 'gitea' }
if ($ssrfHosts -notcontains 'langgraph') { $ssrfHosts += 'langgraph' }
Set-DotEnvValue 'SSRF_ALLOWLIST_HOSTS' ($ssrfHosts -join ',')

Write-Host '[dev-demo] Starting the local Gitea server...'
& docker compose --profile dev-demo up -d gitea
if ($LASTEXITCODE -ne 0) { throw 'Gitea startup failed.' }
$giteaHostUrl = "http://127.0.0.1:$giteaPort"
Wait-ForHttp "$giteaHostUrl/api/healthz"

$userList = (& docker compose --profile dev-demo exec -T --user git gitea gitea admin user list 2>&1) -join "`n"
if ($LASTEXITCODE -ne 0) { throw "Could not inspect Gitea users: $userList" }
if ($userList -notmatch ('(?im)^\s*\d+\s+' + [regex]::Escape($giteaUsername) + '\s+')) {
  Write-Host '[dev-demo] Creating the local Gitea administrator...'
  & docker compose --profile dev-demo exec -T --user git gitea gitea admin user create `
    --username $giteaUsername `
    --password $giteaPassword `
    --email 'argus-dev@example.test' `
    --admin `
    --must-change-password=false
  if ($LASTEXITCODE -ne 0) { throw 'Gitea administrator creation failed.' }
}

$giteaToken = Get-DotEnvValue 'GITEA_TOKEN'
if (-not (Test-GiteaToken $giteaHostUrl $giteaToken)) {
  Write-Host '[dev-demo] Generating a scoped local Gitea API token...'
  $tokenName = 'argus-core-local-' + (Get-Date -Format 'yyyyMMddHHmmss')
  $giteaToken = ((& docker compose --profile dev-demo exec -T --user git gitea gitea admin user generate-access-token `
    --username $giteaUsername `
    --token-name $tokenName `
    --scopes all `
    --raw) -join '').Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($giteaToken)) {
    throw 'Gitea API token generation failed.'
  }
  Set-DotEnvValue 'GITEA_TOKEN' $giteaToken
}

$headers = @{ Authorization = "token $giteaToken"; Accept = 'application/json' }
$repoApiUrl = "$giteaHostUrl/api/v1/repos/$giteaUsername/argus-dev-sample"
$repository = $null
try {
  $repository = Invoke-RestMethod -Uri $repoApiUrl -Headers $headers -TimeoutSec 10
}
catch {
  if ([int]$_.Exception.Response.StatusCode -ne 404) { throw }
}
if ($null -eq $repository) {
  Write-Host '[dev-demo] Creating the real sample repository...'
  $repository = Invoke-RestMethod -Uri "$giteaHostUrl/api/v1/user/repos" `
    -Method Post `
    -Headers $headers `
    -ContentType 'application/json' `
    -Body (@{ name = 'argus-dev-sample'; description = 'Real local target for the Argus.Dev E2E workflow'; private = $true; auto_init = $false; default_branch = 'main' } | ConvertTo-Json) `
    -TimeoutSec 15
}

if ([bool]$repository.empty) {
  Write-Host '[dev-demo] Seeding the baseline service and its Gitea Actions workflow...'
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $seedDir = Join-Path $tempRoot ('argus-dev-seed-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $seedDir | Out-Null
  try {
    Get-ChildItem -LiteralPath (Join-Path $ProjectDir 'demo\argus-dev-sample') -Force |
      Copy-Item -Destination $seedDir -Recurse -Force
    & git -C $seedDir init --initial-branch=main
    & git -C $seedDir config user.name 'Argus Demo Seeder'
    & git -C $seedDir config user.email 'argus-dev@example.test'
    & git -C $seedDir add --all
    & git -C $seedDir commit -m 'Seed Argus.Dev sample service'
    & git -C $seedDir remote add origin "$giteaHostUrl/$giteaUsername/argus-dev-sample.git"
    $basicBytes = [System.Text.Encoding]::UTF8.GetBytes("${giteaUsername}:$giteaToken")
    $basicAuth = [Convert]::ToBase64String($basicBytes)
    & git -C $seedDir -c "http.extraHeader=Authorization: Basic $basicAuth" push -u origin main
    if ($LASTEXITCODE -ne 0) { throw 'Initial sample repository push failed.' }
  }
  finally {
    $resolvedSeedDir = [System.IO.Path]::GetFullPath($seedDir)
    if (-not $resolvedSeedDir.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove unexpected seed path: $resolvedSeedDir"
    }
    if (Test-Path -LiteralPath $resolvedSeedDir) {
      Remove-Item -LiteralPath $resolvedSeedDir -Recurse -Force
    }
  }
}
else {
  Write-Host '[dev-demo] Existing sample repository preserved; no branch was overwritten.'
}

Write-Host '[dev-demo] Starting the isolated Gitea Actions runner...'
& docker compose --profile dev-demo up -d gitea-runner
if ($LASTEXITCODE -ne 0) { throw 'Gitea Actions runner startup failed.' }

if (-not $SkipCoreBuild) {
  Write-Host '[dev-demo] Rebuilding Argus Core/UI and Argus.Dev with Gitea support...'
  & docker compose build mcp-server langgraph
  if ($LASTEXITCODE -ne 0) { throw 'Argus Core or Argus.Dev image build failed.' }
}
Write-Host '[dev-demo] Starting the complete local stack on the shared Argus network...'
& docker compose --profile llm-gateway --profile dev-demo up -d --no-build
if ($LASTEXITCODE -ne 0) { throw 'Argus Core/Dev runtime startup failed.' }
Wait-ForHttp 'http://127.0.0.1:3000/health'

Write-Host '[dev-demo] Installing Gitea into MCP Fabric and linking the governed demo bundle...'
& docker compose exec -T mcp-server node dist/scripts/seedLocalDevDemo.js
if ($LASTEXITCODE -ne 0) { throw 'Argus MCP Fabric demo seed failed.' }
Write-Host '[dev-demo] Reloading Argus Core so the new connection is active in the runtime registry...'
& docker compose restart mcp-server
if ($LASTEXITCODE -ne 0) { throw 'Argus Core connection-registry reload failed.' }
Wait-ForHttp 'http://127.0.0.1:3000/health'

if (-not $SkipSampleImageBuild) {
  Write-Host '[dev-demo] Building the sample service container image...'
  & docker build -t argus-dev-sample:local (Join-Path $ProjectDir 'demo\argus-dev-sample')
  if ($LASTEXITCODE -ne 0) { throw 'Sample service container build failed.' }
}

Write-Host '[dev-demo] Ready.'
Write-Host '[dev-demo] Argus Core: http://localhost:3000'
Write-Host "[dev-demo] Gitea: $giteaHostUrl/$giteaUsername/argus-dev-sample"
Write-Host '[dev-demo] MCP Fabric bundle: Argus.Dev Demo'
Write-Host '[dev-demo] CI: Repository -> Actions -> verify-service'
