[CmdletBinding()]
param(
  [string]$ClusterName = 'argus-aiops',
  [switch]$KeepIncident
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$incidentManifest = Join-Path $repoRoot 'demo\aiops\kubernetes\incident-workload.yaml'
$context = "kind-$ClusterName"
$composeFiles = @(
  '-f', 'docker-compose.yml',
  '-f', 'deploy/compose/packs/compose.external-pack.yml',
  '-f', 'deploy/compose/demo/compose.aiops-demo.yml',
  '--profile', 'aiops-demo'
)

function Resolve-ArgusCommand([string]$Name) {
  $wingetLink = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\$Name.exe"
  if (Test-Path -LiteralPath $wingetLink) { return $wingetLink }
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "$Name is required but was not found in PATH." }
  return $command.Source
}

function Wait-ForIncident([string]$Kubectl) {
  $deadline = (Get-Date).AddMinutes(2)
  do {
    $podJson = & $Kubectl --context $context get pods -n argus-demo `
      -l app.kubernetes.io/name=payment-worker -o json 2>$null
    if ($LASTEXITCODE -eq 0 -and $podJson) {
      $pods = $podJson | ConvertFrom-Json
      $statuses = @($pods.items | ForEach-Object {
        $_.status.containerStatuses | ForEach-Object {
          @($_.state.waiting.reason, $_.state.terminated.reason) -join ' '
        }
      }) -join ' '
      if ($statuses -match 'CrashLoopBackOff|Error') { return }
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw 'The deliberate payment-worker incident did not reach a failing state.'
}

if (-not (Test-Path -LiteralPath $incidentManifest)) {
  throw "Incident manifest not found: $incidentManifest"
}

$kubectl = Resolve-ArgusCommand 'kubectl'
$docker = Resolve-ArgusCommand 'docker'
Set-Location $repoRoot

try {
  Write-Host '[aiops-kubernetes] Applying the controlled payment-worker incident...'
  & $kubectl --context $context apply -f $incidentManifest
  if ($LASTEXITCODE -ne 0) { throw 'Applying the Kubernetes incident failed.' }
  Wait-ForIncident $kubectl

  Write-Host '[aiops-kubernetes] Running the governed AIOps investigation...'
  & $docker compose @composeFiles exec -T `
    -e ARGUS_AIOPS_TEST_TITLE=ARGUS-AIOPS-K8S-CERT `
    -e ARGUS_AIOPS_TEST_SERVICE=payment-worker `
    -e ARGUS_AIOPS_TEST_ENVIRONMENT=argus-demo `
    -e 'ARGUS_AIOPS_TEST_ALERT_SOURCE=Kubernetes BackOff certification' `
    -e 'ARGUS_AIOPS_TEST_SUMMARY=Investigate the failing payment-worker in the explicit Kubernetes namespace argus-demo. Correlate Services, Deployments, Pods, recent Events and pod logs with bounded metrics, Loki logs, Jaeger traces and runbook evidence. Remain read-only.' `
    -e ARGUS_AIOPS_REQUIRE_TOOL_PREFIXES=aiops_kubernetes_ `
    mcp-server node dist/scripts/verifyAiopsWorkflow.js
  if ($LASTEXITCODE -ne 0) { throw 'Kubernetes AIOps workflow certification failed.' }

  Write-Host '[aiops-kubernetes] Certification passed.'
}
finally {
  if ($KeepIncident) {
    Write-Warning 'The deliberate payment-worker incident was retained because -KeepIncident was specified.'
  } else {
    Write-Host '[aiops-kubernetes] Removing the controlled incident...'
    & $kubectl --context $context delete -f $incidentManifest --ignore-not-found=true --wait=true
  }
}
