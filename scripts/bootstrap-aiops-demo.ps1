param(
  [switch]$SkipCoreBuild,
  [switch]$SkipPackBuild,
  [switch]$SkipKubernetes,
  [switch]$SkipKnowledgeSeed
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$PackDir = [System.IO.Path]::GetFullPath((Join-Path $ProjectDir 'packs\argus-aiops'))
Set-Location $ProjectDir

function Wait-ForHttp([string]$Url, [int]$TimeoutSeconds = 120) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      Invoke-RestMethod -Uri $Url -TimeoutSec 3 | Out-Null
      return
    }
    catch { Start-Sleep -Seconds 2 }
  } while ((Get-Date) -lt $deadline)
  throw "Service did not become ready: $Url"
}

function Ensure-ContainerNetworkMembership([string]$ContainerId, [string]$NetworkName) {
  if ([string]::IsNullOrWhiteSpace($ContainerId)) {
    throw "Cannot reconcile Docker network '$NetworkName' without a container id."
  }
  $inspection = @(& docker inspect $ContainerId | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or $inspection.Count -ne 1) {
    throw "Could not inspect container $ContainerId before network reconciliation."
  }
  $attachedNetworks = @($inspection[0].NetworkSettings.Networks.PSObject.Properties.Name)
  if ($attachedNetworks -contains $NetworkName) { return }

  Write-Host "[aiops-demo] Attaching Core to missing Docker network: $NetworkName"
  & docker network connect $NetworkName $ContainerId
  if ($LASTEXITCODE -ne 0) {
    throw "Could not attach container $ContainerId to Docker network '$NetworkName'."
  }
}

if (-not (Test-Path -LiteralPath '.env')) {
  throw 'Missing .env. Run scripts/bootstrap-local.ps1 first so Argus Core secrets exist.'
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker Desktop is required and must be available in PATH.'
}
& cmd.exe /d /c 'docker info >nul 2>&1'
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is installed but the Docker daemon is not running.' }

if (-not $SkipKubernetes) {
  Write-Host '[aiops-demo] Reconciling the local read-only Kubernetes evidence provider...'
  & (Join-Path $PSScriptRoot 'bootstrap-aiops-kubernetes.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'Argus.AIOps Kubernetes bootstrap failed.' }
  Write-Host '[aiops-demo] Reconciling the isolated Kubernetes remediation provider...'
  & (Join-Path $PSScriptRoot 'bootstrap-aiops-kubernetes-remediation.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'Argus.AIOps Kubernetes remediation bootstrap failed.' }
}
if (-not $SkipPackBuild -and -not (Test-Path -LiteralPath (Join-Path $PackDir 'Dockerfile'))) {
  throw "Argus AIOps Pack not found at $PackDir (expected packs\argus-aiops). Restore it or use -SkipPackBuild with an existing argus-aiops:local image."
}

$compose = @(
  'compose',
  '-f', 'docker-compose.yml',
  '-f', 'deploy/compose/packs/compose.external-pack.yml',
  '-f', 'deploy/compose/demo/compose.aiops-demo.yml',
  '--profile', 'aiops-demo'
)

if (-not $SkipCoreBuild) {
  Write-Host '[aiops-demo] Building Argus Core and the current Console...'
  & docker @compose build mcp-server
  if ($LASTEXITCODE -ne 0) { throw 'Argus Core image build failed.' }
}
if (-not $SkipPackBuild) {
  Write-Host '[aiops-demo] Building the external Argus.AIOps pack...'
  & docker build -t argus-aiops:local $PackDir
  if ($LASTEXITCODE -ne 0) { throw 'Argus.AIOps image build failed.' }
}

Write-Host '[aiops-demo] Starting Core, Pack, metrics, logs and traces; then seeding the read-only bundle...'
& docker @compose up -d mcp-server argus-aiops prometheus loki jaeger
if ($LASTEXITCODE -ne 0) { throw 'AIOps demo services failed to start.' }
# Loki and Jaeger are intentionally ephemeral in the local lab. Recreate both
# one-shot seeds after every bootstrap so a host reboot cannot leave a green
# stack with empty evidence stores.
& docker @compose up -d --force-recreate aiops-signal-seed aiops-demo-seed
if ($LASTEXITCODE -ne 0) { throw 'AIOps demo startup or seed failed.' }

# Docker Compose 2.24 on Docker Desktop can occasionally retain only one side
# of this dual-homed service after a partial rebuild. Reconcile both routes so
# Core can reach PostgreSQL/Redis on its private network and the un-published
# Kind NodePort on the separate `kind` network.
$coreContainer = ((& docker @compose ps -q mcp-server) -join '').Trim()
Ensure-ContainerNetworkMembership $coreContainer 'argus-core-network'
Ensure-ContainerNetworkMembership $coreContainer 'kind'

Wait-ForHttp 'http://127.0.0.1:3000/health'
Wait-ForHttp 'http://127.0.0.1:9090/-/ready'
Wait-ForHttp 'http://127.0.0.1:3101/ready'
Wait-ForHttp 'http://127.0.0.1:16686/api/services'

$seedContainer = ((& docker @compose ps -a -q aiops-demo-seed) -join '').Trim()
if ([string]::IsNullOrWhiteSpace($seedContainer)) { throw 'AIOps seed container was not created.' }
$seedExit = (& docker inspect $seedContainer --format '{{.State.ExitCode}}').Trim()
if ($seedExit -ne '0') {
  & docker @compose logs --no-color --tail=100 aiops-demo-seed
  throw "AIOps seed exited with code $seedExit."
}

$signalSeedContainer = ((& docker @compose ps -a -q aiops-signal-seed) -join '').Trim()
if ([string]::IsNullOrWhiteSpace($signalSeedContainer)) { throw 'AIOps signal seed container was not created.' }
$signalSeedExit = (& docker inspect $signalSeedContainer --format '{{.State.ExitCode}}').Trim()
if ($signalSeedExit -ne '0') {
  & docker @compose logs --no-color --tail=100 aiops-signal-seed
  throw "AIOps signal seed exited with code $signalSeedExit."
}

if (-not $SkipKnowledgeSeed) {
  Write-Host '[aiops-demo] Seeding the dedicated pgvector runbook corpus...'
  & docker @compose exec -T mcp-server node dist/scripts/seedAiopsKnowledge.js
  if ($LASTEXITCODE -ne 0) { throw 'Argus.AIOps runbook seed failed.' }
}
else {
  Write-Host '[aiops-demo] Skipping optional embedding-backed runbook seed.'
}

# The SQL seed is deliberately outside product migrations. Reload Core only
# after it committed so the in-memory custom-backend registry sees the provider.
Write-Host '[aiops-demo] Reloading the Core backend registry...'
& docker @compose restart mcp-server
if ($LASTEXITCODE -ne 0) { throw 'Argus Core registry reload failed.' }
Wait-ForHttp 'http://127.0.0.1:3000/health'

Write-Host '[aiops-demo] Verifying metrics, logs and traces through the governed MCP Bundle endpoint...'
& docker @compose exec -T mcp-server node dist/scripts/verifyAiopsDemo.js
if ($LASTEXITCODE -ne 0) { throw 'AIOps multi-signal MCP verification failed.' }

Write-Host '[aiops-demo] Ready.'
Write-Host '[aiops-demo] Argus AIOps: http://localhost:3000/solutions/argus.aiops'
Write-Host '[aiops-demo] Prometheus: http://127.0.0.1:9090'
Write-Host '[aiops-demo] Loki: http://127.0.0.1:3101'
Write-Host '[aiops-demo] Jaeger: http://127.0.0.1:16686'
Write-Host '[aiops-demo] MCP Fabric bundle: Argus.AIOps Observe'
