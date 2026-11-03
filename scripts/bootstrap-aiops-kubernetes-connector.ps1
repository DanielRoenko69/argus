[CmdletBinding()]
param(
  [string]$ClusterName = 'argus-aiops',
  [string]$ReportPath = 'test-results/kubernetes-connector-certification.json',
  [switch]$InstallNetworkPolicyController
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$labRoot = Join-Path $repoRoot 'demo\aiops\kubernetes'
$namespaces = Join-Path $labRoot 'namespaces.yaml'
$values = Join-Path $labRoot 'kagent-tools-in-cluster-values.yaml'
$networkPolicy = Join-Path $labRoot 'network-policy.in-cluster.yaml'
$networkPolicyController = Join-Path $labRoot 'kube-router-network-policy.yaml'
$contract = Join-Path $labRoot 'connector-contract.in-cluster.json'
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

$kubectl = Resolve-ArgusCommand 'kubectl'
$helm = Resolve-ArgusCommand 'helm'
$node = Resolve-ArgusCommand 'node'
Set-Location $repoRoot

$contexts = @(& $kubectl config get-contexts -o name)
if ($contexts -notcontains $context) {
  throw "Kubernetes context $context does not exist. Run .\scripts\bootstrap-aiops-kubernetes.ps1 first."
}

Write-Host '[kubernetes-connector] Reconciling namespaces and in-cluster connector...'
& $kubectl --context $context apply -f $namespaces
if ($LASTEXITCODE -ne 0) { throw 'Namespace reconciliation failed.' }

& $helm upgrade --install argus-kubernetes-connector $chart `
  --version $chartVersion `
  --kube-context $context `
  --namespace argus-aiops-system `
  --values $values `
  --wait `
  --timeout 5m
if ($LASTEXITCODE -ne 0) { throw 'In-cluster Kubernetes connector installation failed.' }

& $kubectl --context $context apply -f $networkPolicy
if ($LASTEXITCODE -ne 0) { throw 'In-cluster NetworkPolicy installation failed.' }

if ($InstallNetworkPolicyController) {
  Write-Warning 'Installing the local-lab fallback NetworkPolicy controller. It is a privileged hostNetwork/hostPID DaemonSet with cluster-wide read-only RBAC.'
  & $kubectl --context $context apply -f $networkPolicyController
  if ($LASTEXITCODE -ne 0) { throw 'NetworkPolicy controller installation failed.' }
  & $kubectl --context $context -n kube-system rollout status daemonset/argus-network-policy-controller --timeout=3m
  if ($LASTEXITCODE -ne 0) { throw 'NetworkPolicy controller did not become ready.' }
}

& $kubectl --context $context -n argus-aiops-system rollout status deployment/argus-kubernetes-connector --timeout=3m
if ($LASTEXITCODE -ne 0) { throw 'In-cluster Kubernetes connector did not become ready.' }

Write-Host '[kubernetes-connector] Running the reusable connector certification contract...'
& $node scripts/certify-kubernetes-connector.mjs --contract $contract --report $ReportPath
if ($LASTEXITCODE -ne 0) { throw 'In-cluster Kubernetes connector certification failed.' }

Write-Host ''
Write-Host 'Argus Kubernetes connector certification passed.'
Write-Host 'In-cluster MCP endpoint: http://argus-kubernetes-connector.argus-aiops-system.svc.cluster.local:8084/mcp'
Write-Host "Evidence report: $ReportPath"
