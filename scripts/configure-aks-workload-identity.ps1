[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)]
  [string]$Context,

  [string]$Namespace = 'argus-aiops-system',
  [string]$Deployment = 'argus-kubernetes-connector',
  [string]$ServiceAccount = 'argus-kubernetes-connector',

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')]
  [string]$ClientId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')]
  [string]$TenantId,

  [ValidateRange(600, 86400)]
  [int]$TokenExpirationSeconds = 3600
)

$ErrorActionPreference = 'Stop'

function Resolve-ArgusCommand([string]$Name) {
  $wingetLink = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\$Name.exe"
  if (Test-Path -LiteralPath $wingetLink) { return $wingetLink }
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "$Name is required but was not found in PATH." }
  return $command.Source
}

$kubectl = Resolve-ArgusCommand 'kubectl'
$contexts = @(& $kubectl config get-contexts -o name)
if ($contexts -notcontains $Context) { throw "Kubernetes context $Context does not exist." }

& $kubectl --context $Context get serviceaccount $ServiceAccount -n $Namespace 1>$null
if ($LASTEXITCODE -ne 0) { throw "ServiceAccount $Namespace/$ServiceAccount does not exist." }
& $kubectl --context $Context get deployment $Deployment -n $Namespace 1>$null
if ($LASTEXITCODE -ne 0) { throw "Deployment $Namespace/$Deployment does not exist." }

if (-not $PSCmdlet.ShouldProcess("$Context/$Namespace/$Deployment", 'Configure AKS Workload Identity metadata and restart the connector Pod')) {
  return
}

Write-Host '[aks-workload-identity] Annotating the dedicated ServiceAccount...'
& $kubectl --context $Context annotate serviceaccount $ServiceAccount -n $Namespace `
  "azure.workload.identity/client-id=$ClientId" `
  "azure.workload.identity/tenant-id=$TenantId" `
  "azure.workload.identity/service-account-token-expiration=$TokenExpirationSeconds" `
  --overwrite
if ($LASTEXITCODE -ne 0) { throw 'ServiceAccount annotation failed.' }

$patch = @{
  spec = @{
    template = @{
      metadata = @{
        labels = @{
          'azure.workload.identity/use' = 'true'
        }
      }
    }
  }
} | ConvertTo-Json -Depth 8 -Compress

Write-Host '[aks-workload-identity] Enabling fail-close webhook mutation on the connector Pods...'
& $kubectl --context $Context patch deployment $Deployment -n $Namespace --type merge --patch $patch
if ($LASTEXITCODE -ne 0) { throw 'Deployment Workload Identity patch failed.' }

& $kubectl --context $Context rollout status deployment/$Deployment -n $Namespace --timeout=5m
if ($LASTEXITCODE -ne 0) { throw 'The Workload Identity connector rollout did not become ready.' }

Write-Host ''
Write-Host 'AKS Workload Identity metadata is configured.'
Write-Host 'Run the connector certification with the matching AKS contract to verify webhook injection and Azure federation.'
