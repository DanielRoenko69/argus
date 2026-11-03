[CmdletBinding()]
param(
  [string]$ClusterName = 'argus-aiops',
  [switch]$SkipDemoWorkload
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$labRoot = Join-Path $repoRoot 'demo\aiops\kubernetes'
$kindConfig = Join-Path $labRoot 'kind-cluster.yaml'
$namespaces = Join-Path $labRoot 'namespaces.yaml'
$values = Join-Path $labRoot 'kagent-tools-values.yaml'
$networkPolicy = Join-Path $labRoot 'network-policy.yaml'
$demoWorkload = Join-Path $labRoot 'demo-workload.yaml'

$kindImage = 'kindest/node:v1.34.8@sha256:02722c2dedddcfc00febf5d27fbeb9b7b2c14294c82109ff4a85d89ac9ba3256'
$chart = 'oci://ghcr.io/kagent-dev/tools/helm/kagent-tools'
$chartVersion = '0.2.1'
$context = "kind-$ClusterName"

function Resolve-ArgusCommand([string]$Name) {
  $wingetLink = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\$Name.exe"
  if (Test-Path -LiteralPath $wingetLink) { return $wingetLink }
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "$Name is required but was not found in PATH." }
  return $command.Source
}

$kind = Resolve-ArgusCommand 'kind'
$kubectl = Resolve-ArgusCommand 'kubectl'
$helm = Resolve-ArgusCommand 'helm'
$docker = Resolve-ArgusCommand 'docker'

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $docker info 1>$null 2>$null
$dockerExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($dockerExitCode -ne 0) { throw 'Docker is not ready.' }

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$clusters = @(& $kind get clusters 2>$null)
$ErrorActionPreference = $previousErrorActionPreference
if ($clusters -notcontains $ClusterName) {
  Write-Host "Creating Kind cluster $ClusterName with Kubernetes 1.34.8..."
  & $kind create cluster --name $ClusterName --image $kindImage --config $kindConfig --wait 5m
  if ($LASTEXITCODE -ne 0) { throw 'Kind cluster creation failed.' }
} else {
  Write-Host "Kind cluster $ClusterName already exists; reconciling its workloads."
}

& $kubectl --context $context apply -f $namespaces
if ($LASTEXITCODE -ne 0) { throw 'Namespace bootstrap failed.' }

& $helm upgrade --install argus-kubernetes-tools $chart `
  --version $chartVersion `
  --kube-context $context `
  --namespace argus-aiops-system `
  --values $values `
  --wait `
  --timeout 5m
if ($LASTEXITCODE -ne 0) { throw 'kagent-tools installation failed.' }

& $kubectl --context $context apply -f $networkPolicy
if ($LASTEXITCODE -ne 0) { throw 'NetworkPolicy installation failed.' }

if (-not $SkipDemoWorkload) {
  & $kubectl --context $context apply -f $demoWorkload
  if ($LASTEXITCODE -ne 0) { throw 'Demo workload installation failed.' }
  & $kubectl --context $context -n argus-demo rollout status deployment/checkout-api --timeout=3m
  & $kubectl --context $context -n argus-demo rollout status deployment/catalog-api --timeout=3m
}

& $kubectl --context $context -n argus-aiops-system rollout status deployment/argus-kubernetes-tools --timeout=3m
if ($LASTEXITCODE -ne 0) { throw 'kagent-tools did not become ready.' }

$serviceAccount = 'system:serviceaccount:argus-aiops-system:argus-kubernetes-tools'
function Assert-KubernetesPermission(
  [string]$Verb,
  [string]$Resource,
  [string]$Namespace,
  [string]$Expected
) {
  $actual = (& $kubectl --context $context auth can-i $Verb $Resource `
    --namespace $Namespace --as=$serviceAccount).Trim().ToLowerInvariant()
  if ($actual -ne $Expected) {
    throw "Unexpected Kubernetes permission: $Verb $Resource in $Namespace was '$actual', expected '$Expected'."
  }
}

Assert-KubernetesPermission 'get' 'pods' 'argus-demo' 'yes'
Assert-KubernetesPermission 'delete' 'pods' 'argus-demo' 'no'
Assert-KubernetesPermission 'get' 'secrets' 'argus-demo' 'no'
Assert-KubernetesPermission 'get' 'pods' 'kube-system' 'no'

Write-Host ''
Write-Host 'Argus.AIOps Kubernetes evidence lab is ready.'
Write-Host "Context: $context"
Write-Host 'Host MCP endpoint: http://127.0.0.1:18084/mcp'
Write-Host 'Argus Docker endpoint: http://host.docker.internal:18084/mcp'
& $kubectl --context $context get nodes -o wide
& $kubectl --context $context get pods -A
