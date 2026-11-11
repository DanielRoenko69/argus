[CmdletBinding()]
param(
  [string]$ClusterName = 'argus-aiops'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$context = "kind-$ClusterName"
$namespace = 'argus-demo'
$deployment = 'checkout-api'
$compose = @(
  'compose',
  '-f', 'docker-compose.yml',
  '-f', 'deploy/compose/packs/compose.external-pack.yml',
  '-f', 'deploy/compose/demo/compose.aiops-demo.yml',
  '--profile', 'aiops-demo'
)

Set-Location $repoRoot
$originalText = (& kubectl --context $context -n $namespace get deployment $deployment -o jsonpath='{.spec.replicas}').Trim()
$original = 0
if (-not [int]::TryParse($originalText, [ref]$original) -or $original -lt 1) {
  throw "Could not read a safe original replica count for $namespace/$deployment."
}

$failure = $null
try {
  & docker @compose exec -T `
    -e ARGUS_AIOPS_REMEDIATION_E2E_CONFIRM=scale-and-restore-argus-demo `
    mcp-server npm run verify:aiops-remediation
  if ($LASTEXITCODE -ne 0) { throw "Argus remediation verifier exited with code $LASTEXITCODE." }
}
catch { $failure = $_ }
finally {
  # Independent lab guard: even a transport crash or terminated Node process
  # cannot leave the controlled demo workload at a temporary template revision.
  & kubectl --context $context apply -f (Join-Path $repoRoot 'demo\aiops\kubernetes\demo-workload.yaml')
  if ($LASTEXITCODE -ne 0) { throw 'Emergency demo-workload manifest restore failed.' }
  $currentText = (& kubectl --context $context -n $namespace get deployment $deployment -o jsonpath='{.spec.replicas}').Trim()
  $current = 0
  if (-not [int]::TryParse($currentText, [ref]$current) -or $current -ne $original) {
    Write-Warning "Verifier did not leave $namespace/$deployment at $original replicas; restoring through the operator context."
    & kubectl --context $context -n $namespace scale deployment/$deployment --replicas=$original
    if ($LASTEXITCODE -ne 0) { throw 'Emergency demo-workload restore failed.' }
  }
  & kubectl --context $context -n $namespace rollout status deployment/$deployment --timeout=90s
  if ($LASTEXITCODE -ne 0) { throw 'Restored demo workload did not become ready.' }
}

if ($failure) { throw $failure }
Write-Host "[aiops-remediation] E2E passed; $namespace/$deployment is restored at $original replicas."
