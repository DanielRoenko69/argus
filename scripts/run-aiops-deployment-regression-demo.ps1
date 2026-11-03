[CmdletBinding()]
param(
  [string]$ClusterName = 'argus-aiops',
  [ValidateRange(2, 60)]
  [int]$ApprovalTimeoutMinutes = 20,
  [switch]$KeepIncidentOnFailure
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$regressionPatch = Join-Path $repoRoot 'demo\aiops\kubernetes\checkout-api-regression-patch.yaml'
$context = "kind-$ClusterName"
$namespace = 'argus-demo'
$deployment = 'checkout-api'
$composeFiles = @(
  '-f', 'docker-compose.yml',
  '-f', 'compose.external-pack.yml',
  '-f', 'compose.aiops-demo.yml',
  '--profile', 'aiops-demo'
)
$completed = $false
$healthyRevision = $null
$demoRunId = [guid]::NewGuid().ToString()

function Resolve-ArgusCommand([string]$Name) {
  $wingetLink = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\$Name.exe"
  if (Test-Path -LiteralPath $wingetLink) { return $wingetLink }
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "$Name is required but was not found in PATH." }
  return $command.Source
}

function Get-Deployment([string]$Kubectl) {
  $raw = & $Kubectl --context $context -n $namespace get deployment $deployment -o json
  if ($LASTEXITCODE -ne 0 -or -not $raw) { throw "Unable to read Deployment $namespace/$deployment." }
  return $raw | ConvertFrom-Json
}

function Wait-ForRegression([string]$Kubectl, [string]$PreviousRevision) {
  $deadline = (Get-Date).AddMinutes(2)
  do {
    $state = Get-Deployment $Kubectl
    $revision = [string]$state.metadata.annotations.'deployment.kubernetes.io/revision'
    $marker = [string]$state.spec.template.metadata.annotations.'argus.aiops/demo-regression'
    $unavailable = if ($null -eq $state.status.unavailableReplicas) { 0 } else { [int]$state.status.unavailableReplicas }
    if ($revision -ne $PreviousRevision -and $marker -eq 'unready-rollout-v1' -and $unavailable -gt 0) {
      return $revision
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw 'The controlled checkout-api revision did not become observably unready.'
}

function Test-Recovered([string]$Kubectl) {
  $state = Get-Deployment $Kubectl
  $marker = [string]$state.spec.template.metadata.annotations.'argus.aiops/demo-regression'
  $desired = if ($null -eq $state.spec.replicas) { 0 } else { [int]$state.spec.replicas }
  $updated = if ($null -eq $state.status.updatedReplicas) { 0 } else { [int]$state.status.updatedReplicas }
  $available = if ($null -eq $state.status.availableReplicas) { 0 } else { [int]$state.status.availableReplicas }
  $unavailable = if ($null -eq $state.status.unavailableReplicas) { 0 } else { [int]$state.status.unavailableReplicas }
  return -not $marker -and $desired -gt 0 -and $updated -eq $desired -and $available -eq $desired -and $unavailable -eq 0
}

function Restore-HealthyRevision([string]$Kubectl, [string]$Revision) {
  if (Test-Recovered $Kubectl) {
    Write-Host '[aiops-deployment-demo] checkout-api is already healthy; no second operator rollback is needed.'
    return
  }
  Write-Host "[aiops-deployment-demo] Restoring retained healthy revision $Revision through the operator cleanup path..."
  & $Kubectl --context $context -n $namespace rollout undo "deployment/$deployment" "--to-revision=$Revision"
  if ($LASTEXITCODE -ne 0) { throw 'Operator cleanup rollback failed.' }
  & $Kubectl --context $context -n $namespace rollout status "deployment/$deployment" --timeout=3m
  if ($LASTEXITCODE -ne 0) { throw 'checkout-api did not become healthy during operator cleanup.' }
}

if (-not (Test-Path -LiteralPath $regressionPatch)) {
  throw "Regression patch not found: $regressionPatch"
}

$kubectl = Resolve-ArgusCommand 'kubectl'
$docker = Resolve-ArgusCommand 'docker'
Set-Location $repoRoot

try {
  $before = Get-Deployment $kubectl
  $healthyRevision = [string]$before.metadata.annotations.'deployment.kubernetes.io/revision'
  if (-not $healthyRevision) { throw 'checkout-api has no retained healthy Deployment revision.' }
  if (-not (Test-Recovered $kubectl)) {
    throw 'checkout-api is not healthy before the demo. Restore it before injecting a new regression.'
  }

  Write-Host "[aiops-deployment-demo] Healthy baseline is revision $healthyRevision. Injecting an unready pod template..."
  & $kubectl --context $context -n $namespace patch deployment $deployment --type strategic --patch-file $regressionPatch
  if ($LASTEXITCODE -ne 0) { throw 'Applying the controlled checkout-api regression failed.' }
  $badRevision = Wait-ForRegression $kubectl $healthyRevision
  Write-Host "[aiops-deployment-demo] Revision $badRevision is unready; existing ready Pods continue serving traffic."

  Write-Host '[aiops-deployment-demo] Starting the governed read-only Agent investigation...'
  $demoOutput = & $docker compose @composeFiles exec -T `
    -e ARGUS_AIOPS_DEMO_REMEDIATION=deployment-revision `
    -e "ARGUS_AIOPS_TARGET_REVISION=$healthyRevision" `
    -e "ARGUS_AIOPS_DEMO_RUN_ID=$demoRunId" `
    mcp-server node dist/scripts/runAiopsIncidentDemo.js
  if ($LASTEXITCODE -ne 0) { throw 'The Argus.AIOps investigation failed.' }
  $demoText = $demoOutput -join "`n"
  Write-Host $demoText
  $jsonStart = $demoText.IndexOf('{')
  if ($jsonStart -lt 0) { throw 'The AIOps demo did not return its incident evidence.' }
  $result = $demoText.Substring($jsonStart) | ConvertFrom-Json
  $incidentId = [int]$result.incidentId
  if ($incidentId -lt 1) { throw 'The AIOps demo returned an invalid incident id.' }

  $incidentUrl = "http://localhost:3000/observe/alerts?incident=$incidentId"
  Write-Host ''
  Write-Host '[aiops-deployment-demo] Investigation complete. Open the incident and:'
  Write-Host '  1. approve the revision remediation proposal;'
  Write-Host '  2. create the immutable change plan;'
  Write-Host '  3. approve its exact hash;'
  Write-Host '  4. execute the plan.'
  Write-Host "  $incidentUrl"
  Write-Host "[aiops-deployment-demo] Waiting up to $ApprovalTimeoutMinutes minutes for Core-verified recovery..."

  $deadline = (Get-Date).AddMinutes($ApprovalTimeoutMinutes)
  do {
    if (Test-Recovered $kubectl) { break }
    Start-Sleep -Seconds 5
  } while ((Get-Date) -lt $deadline)
  if (-not (Test-Recovered $kubectl)) {
    throw 'Timed out waiting for the approved Argus revision rollback.'
  }

  $completion = & $docker compose @composeFiles exec -T `
    -e "ARGUS_AIOPS_INCIDENT_ID=$incidentId" `
    mcp-server node dist/scripts/completeAiopsDeploymentRegressionDemo.js
  if ($LASTEXITCODE -ne 0) {
    throw 'The workload recovered, but Core has no verified revision plan for incident completion.'
  }
  Write-Host ($completion -join "`n")
  Write-Host "[aiops-deployment-demo] Passed: revision $badRevision was diagnosed, approved, restored and verified."
  $completed = $true
}
finally {
  if (-not $completed -and $healthyRevision) {
    if ($KeepIncidentOnFailure) {
      Write-Warning 'The controlled regression was retained because -KeepIncidentOnFailure was specified.'
    } else {
      try {
        Restore-HealthyRevision $kubectl $healthyRevision
      } catch {
        if (-not (Test-Recovered $kubectl)) { throw }
        Write-Warning "The numbered revision was no longer retained, but checkout-api is already healthy: $($_.Exception.Message)"
      }
      if (Test-Recovered $kubectl) {
        $abortResult = & $docker compose @composeFiles exec -T `
          -e "ARGUS_AIOPS_DEMO_RUN_ID=$demoRunId" `
          mcp-server node dist/scripts/abortAiopsDeploymentRegressionDemo.js
        if ($LASTEXITCODE -ne 0) {
          Write-Warning 'The workload was restored, but the aborted demo incident could not be closed automatically.'
        } elseif ($abortResult) {
          Write-Host ($abortResult -join "`n")
        }
      }
    }
  }
}
