param(
  [string]$SourceUrl = 'https://github.com/fastapi/full-stack-fastapi-template.git',
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$SourceRef = '162344da111e833b30892728372ab95331f06873',
  [ValidatePattern('^[a-z0-9][a-z0-9._-]{1,99}$')]
  [string]$RepositoryName = 'argus-dev-fastapi-e2e',
  [ValidatePattern('^https?://[^\s]+$')]
  [string]$CiWebhookUrl = 'http://mcp-server:3000/api/coding/webhook/ci/gitea',
  [switch]$WithoutCiWorkflow
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $ProjectDir

function Get-DotEnvValue([string]$Key) {
  $match = [System.IO.File]::ReadAllLines((Resolve-Path '.env')) |
    Where-Object { $_ -match ('^' + [regex]::Escape($Key) + '=') } |
    Select-Object -Last 1
  if ($null -eq $match) { return '' }
  return $match.Substring($Key.Length + 1)
}

function Set-GiteaCiWebhook(
  [string]$RepositoryHooksUrl,
  [hashtable]$RequestHeaders,
  [string]$TargetUrl,
  [string]$Secret
) {
  $hooks = @(Invoke-RestMethod -Uri $RepositoryHooksUrl -Headers $RequestHeaders -TimeoutSec 15)
  $existing = $hooks |
    Where-Object { $_.config.url -eq $TargetUrl } |
    Select-Object -First 1
  $payload = @{
    active = $true
    events = @('workflow_run')
    config = @{
      url = $TargetUrl
      content_type = 'json'
      secret = $Secret
    }
  }
  if ($null -eq $existing) {
    $payload.type = 'gitea'
    $hook = Invoke-RestMethod -Uri $RepositoryHooksUrl `
      -Method Post `
      -Headers $RequestHeaders `
      -ContentType 'application/json' `
      -Body ($payload | ConvertTo-Json -Depth 5) `
      -TimeoutSec 15
    Write-Host "[dev-e2e] Created signed Gitea workflow_run webhook #$($hook.id)."
    return
  }
  $hook = Invoke-RestMethod -Uri "$RepositoryHooksUrl/$($existing.id)" `
    -Method Patch `
    -Headers $RequestHeaders `
    -ContentType 'application/json' `
    -Body ($payload | ConvertTo-Json -Depth 5) `
    -TimeoutSec 15
  Write-Host "[dev-e2e] Refreshed signed Gitea workflow_run webhook #$($hook.id)."
}

if (-not (Test-Path -LiteralPath '.env')) {
  throw 'Missing .env. Bootstrap the local Argus development environment first.'
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'Git is required to import the pinned source snapshot.'
}

$giteaToken = Get-DotEnvValue 'GITEA_TOKEN'
if ([string]::IsNullOrWhiteSpace($giteaToken)) { throw 'GITEA_TOKEN is missing from .env.' }
$giteaCiWebhookSecret = Get-DotEnvValue 'GITEA_CI_WEBHOOK_SECRET'
if (-not $WithoutCiWorkflow -and [string]::IsNullOrWhiteSpace($giteaCiWebhookSecret)) {
  throw 'GITEA_CI_WEBHOOK_SECRET is required when installing the CI workflow.'
}
$giteaOwner = Get-DotEnvValue 'GITEA_OWNER'
if ([string]::IsNullOrWhiteSpace($giteaOwner)) { $giteaOwner = 'argus' }
$giteaPort = Get-DotEnvValue 'GITEA_PORT'
if ($giteaPort -notmatch '^\d+$') { $giteaPort = '3005' }
$giteaUrl = "http://127.0.0.1:$giteaPort"
$headers = @{ Authorization = "token $giteaToken"; Accept = 'application/json' }

Invoke-RestMethod -Uri "$giteaUrl/api/v1/user" -Headers $headers -TimeoutSec 10 | Out-Null
$repositoryUrl = "$giteaUrl/api/v1/repos/$giteaOwner/$RepositoryName"
$repository = $null
try {
  $repository = Invoke-RestMethod -Uri $repositoryUrl -Headers $headers -TimeoutSec 10
}
catch {
  if ([int]$_.Exception.Response.StatusCode -ne 404) { throw }
}
if ($null -ne $repository -and -not [bool]$repository.empty) {
  throw "Refusing to overwrite the non-empty repository $giteaOwner/$RepositoryName."
}

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$importDir = Join-Path $tempBase ('argus-dev-e2e-import-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $importDir | Out-Null
try {
  & git -C $importDir init
  if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the temporary source repository.' }
  & git -C $importDir remote add upstream $SourceUrl
  & git -C $importDir fetch --depth 1 upstream $SourceRef
  if ($LASTEXITCODE -ne 0) { throw "Could not fetch pinned upstream commit $SourceRef." }
  $resolvedRef = ((& git -C $importDir rev-parse FETCH_HEAD) -join '').Trim()
  if ($resolvedRef -ne $SourceRef) { throw "Fetched $resolvedRef instead of pinned commit $SourceRef." }
  & git -C $importDir checkout --detach FETCH_HEAD
  if ($LASTEXITCODE -ne 0) { throw 'Could not check out the pinned source snapshot.' }

  $temporaryGitDir = [System.IO.Path]::GetFullPath((Join-Path $importDir '.git'))
  if (-not $temporaryGitDir.StartsWith($importDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove unexpected Git metadata path: $temporaryGitDir"
  }
  Remove-Item -LiteralPath $temporaryGitDir -Recurse -Force

  if (-not $WithoutCiWorkflow) {
    $workflowDir = Join-Path $importDir '.gitea\workflows'
    New-Item -ItemType Directory -Path $workflowDir -Force | Out-Null
    $workflow = @'
name: Argus backend verification

on:
  push:
    branches: ['main', 'feature/**']
  pull_request:
    branches: ['main']

jobs:
  backend:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: app
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd "pg_isready -U postgres -d app"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 10
    env:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/app
      FASTAPI_ENV: development
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v6
        with:
          enable-cache: true
      - name: Install locked dependencies
        working-directory: backend
        run: uv sync --frozen
      - name: Apply database migrations
        working-directory: backend
        run: uv run alembic upgrade head
      - name: Run backend tests
        working-directory: backend
        run: uv run python -m pytest
'@
    [System.IO.File]::WriteAllText(
      (Join-Path $workflowDir 'argus-backend.yml'),
      $workflow,
      [System.Text.UTF8Encoding]::new($false)
    )
  }

  if ($null -eq $repository) {
    $repository = Invoke-RestMethod -Uri "$giteaUrl/api/v1/user/repos" `
      -Method Post `
      -Headers $headers `
      -ContentType 'application/json' `
      -Body (@{
        name = $RepositoryName
        description = "Argus.Dev E2E snapshot of $SourceUrl at $SourceRef"
        private = $true
        auto_init = $false
        default_branch = 'main'
      } | ConvertTo-Json) `
      -TimeoutSec 15
  }

  if (-not $WithoutCiWorkflow) {
    Set-GiteaCiWebhook `
      -RepositoryHooksUrl "$repositoryUrl/hooks" `
      -RequestHeaders $headers `
      -TargetUrl $CiWebhookUrl `
      -Secret $giteaCiWebhookSecret
  }

  & git -C $importDir init --initial-branch=main
  & git -C $importDir config user.name 'Argus E2E Importer'
  & git -C $importDir config user.email 'argus-dev@example.test'
  & git -C $importDir add --all
  & git -C $importDir commit -m "Import upstream snapshot $SourceRef"
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the reproducible import commit.' }
  & git -C $importDir remote add origin "$giteaUrl/$giteaOwner/$RepositoryName.git"
  $basicBytes = [System.Text.Encoding]::UTF8.GetBytes("${giteaOwner}:$giteaToken")
  $basicAuth = [Convert]::ToBase64String($basicBytes)
  & git -C $importDir -c "http.extraHeader=Authorization: Basic $basicAuth" push -u origin main
  if ($LASTEXITCODE -ne 0) { throw 'Could not push the imported snapshot into local Gitea.' }

  Write-Host "[dev-e2e] Imported $SourceUrl@$SourceRef"
  Write-Host "[dev-e2e] Repository: $giteaUrl/$giteaOwner/$RepositoryName"
}
finally {
  $resolvedImportDir = [System.IO.Path]::GetFullPath($importDir)
  if (-not $resolvedImportDir.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove unexpected import path: $resolvedImportDir"
  }
  if (Test-Path -LiteralPath $resolvedImportDir) {
    Remove-Item -LiteralPath $resolvedImportDir -Recurse -Force
  }
}
