[CmdletBinding()]
param(
  [string]$ClusterName = 'argus-aiops'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $repoRoot 'demo\aiops\kubernetes\remediation-connector.yaml'
$context = "kind-$ClusterName"
$namespace = 'argus-aiops-system'
$serviceAccount = 'system:serviceaccount:argus-aiops-system:argus-kubernetes-remediation'
$image = 'argus-aiops-remediation-connector:local'

function Resolve-ArgusCommand([string]$Name) {
  $wingetLink = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\$Name.exe"
  if (Test-Path -LiteralPath $wingetLink) { return $wingetLink }
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "$Name is required but was not found in PATH." }
  return $command.Source
}

function Assert-KubernetesPermission(
  [string]$Verb,
  [string]$Resource,
  [string]$Namespace,
  [string]$Expected
) {
  $resourceParts = $Resource.Split('/', 2)
  $resourceArgs = @($resourceParts[0])
  if ($resourceParts.Count -eq 2) { $resourceArgs += "--subresource=$($resourceParts[1])" }
  $actual = (& $kubectl --context $context auth can-i $Verb @resourceArgs `
    --namespace $Namespace --as=$serviceAccount).Trim().ToLowerInvariant()
  if ($actual -ne $Expected) {
    throw "Unexpected remediation permission: $Verb $Resource in $Namespace was '$actual', expected '$Expected'."
  }

  # `kubectl auth can-i` deliberately exits 1 for the expected "no" result.
  # Once the assertion has matched, clear that transport exit code so callers
  # do not mistake a successfully proven deny boundary for a script failure.
  $global:LASTEXITCODE = 0
}

$kubectl = Resolve-ArgusCommand 'kubectl'
$docker = Resolve-ArgusCommand 'docker'
$kind = Resolve-ArgusCommand 'kind'
$contexts = @(& $kubectl config get-contexts -o name)
if ($contexts -notcontains $context) {
  throw "Kubernetes context $context does not exist. Run .\scripts\bootstrap-aiops-kubernetes.ps1 first."
}

Write-Host '[aiops-remediation] Building and loading the workload-scoped Kubernetes MCP connector...'
& $docker build -f (Join-Path $repoRoot 'demo\aiops\kubernetes\remediation-connector\Dockerfile') -t $image $repoRoot
if ($LASTEXITCODE -ne 0) { throw 'Remediation connector image build failed.' }
& $kind load docker-image $image --name $ClusterName
if ($LASTEXITCODE -ne 0) { throw 'Remediation connector image could not be loaded into Kind.' }

Write-Host '[aiops-remediation] Installing the isolated Kubernetes MCP connector...'
& $kubectl --context $context apply -f $manifest
if ($LASTEXITCODE -ne 0) { throw 'Remediation connector installation failed.' }
& $kubectl --context $context -n $namespace rollout status deployment/argus-kubernetes-remediation --timeout=3m
if ($LASTEXITCODE -ne 0) { throw 'Remediation connector did not become ready.' }

Write-Host '[aiops-remediation] Verifying the positive and negative RBAC boundary...'
Assert-KubernetesPermission 'get' 'deployments/scale' 'argus-demo' 'yes'
Assert-KubernetesPermission 'update' 'deployments/scale' 'argus-demo' 'yes'
Assert-KubernetesPermission 'patch' 'statefulsets/scale' 'argus-demo' 'yes'
Assert-KubernetesPermission 'get' 'deployments' 'argus-demo' 'yes'
Assert-KubernetesPermission 'patch' 'deployments' 'argus-demo' 'yes'
Assert-KubernetesPermission 'update' 'deployments' 'argus-demo' 'no'
Assert-KubernetesPermission 'list' 'replicasets' 'argus-demo' 'yes'
Assert-KubernetesPermission 'delete' 'pods' 'argus-demo' 'no'
Assert-KubernetesPermission 'get' 'secrets' 'argus-demo' 'no'
Assert-KubernetesPermission 'get' 'deployments/scale' 'kube-system' 'no'

Write-Host ''
Write-Host 'Argus.AIOps Kubernetes remediation connector is ready.'
Write-Host "Argus Docker endpoint: http://$ClusterName-control-plane:30085/mcp"
Write-Host 'The NodePort is attached only to the private Kind Docker network and is not host-published.'
Write-Host 'RBAC: scale subresources plus Deployment patch and ReplicaSet history in argus-demo.'
Write-Host 'Connector boundary: checkout-api only; revision writes require exact stale-plan and target fingerprints.'
