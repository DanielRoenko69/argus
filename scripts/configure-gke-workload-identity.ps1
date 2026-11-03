[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)]
  [string]$Context,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')]
  [string]$ProjectId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9]{6,32}$')]
  [string]$ProjectNumber,

  [Parameter(Mandatory = $true)]
  [string]$Location,

  [Parameter(Mandatory = $true)]
  [string]$ClusterName,

  [Parameter(Mandatory = $true)]
  [ValidateSet('standard', 'autopilot')]
  [string]$ClusterMode,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string[]]$RequiredRoles,

  [string]$Configuration,
  [string]$Namespace = 'argus-aiops-system',
  [string]$Deployment = 'argus-kubernetes-connector',
  [string]$ServiceAccount = 'argus-kubernetes-connector',
  [switch]$AddIamBindings,
  [switch]$PatchNodeSelector,
  [switch]$RestartDeployment
)

$ErrorActionPreference = 'Stop'

function Resolve-ArgusCommand([string]$Name, [string]$Override) {
  if ($Override) {
    if (-not (Test-Path -LiteralPath $Override)) { throw "$Name override does not exist: $Override" }
    return $Override
  }
  $wingetLink = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\$Name.exe"
  if (Test-Path -LiteralPath $wingetLink) { return $wingetLink }
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "$Name is required but was not found in PATH." }
  return $command.Source
}

foreach ($role in $RequiredRoles) {
  if ($role -notmatch '^roles/[A-Za-z0-9_.]+$') { throw "Invalid IAM role: $role" }
  if ($role -in @('roles/owner', 'roles/editor')) { throw "Refusing broad IAM role: $role" }
}

$kubectl = Resolve-ArgusCommand 'kubectl' $env:KUBECTL_BIN
$gcloud = Resolve-ArgusCommand 'gcloud' $env:GCLOUD_BIN
$contexts = @(& $kubectl config get-contexts -o name)
if ($contexts -notcontains $Context) { throw "Kubernetes context $Context does not exist." }

$serviceAccountJson = & $kubectl --context $Context get serviceaccount $ServiceAccount -n $Namespace -o json
if ($LASTEXITCODE -ne 0) { throw "ServiceAccount $Namespace/$ServiceAccount does not exist." }
$serviceAccountResource = $serviceAccountJson | ConvertFrom-Json
$serviceAccountUid = [string]$serviceAccountResource.metadata.uid
if (-not $serviceAccountUid) { throw "ServiceAccount $Namespace/$ServiceAccount has no UID." }
$gsaAnnotation = $serviceAccountResource.metadata.annotations.'iam.gke.io/gcp-service-account'
if ($gsaAnnotation) {
  throw "ServiceAccount $Namespace/$ServiceAccount still impersonates $gsaAnnotation. Remove the annotation explicitly before using the direct UID principal."
}

$deploymentJson = & $kubectl --context $Context get deployment $Deployment -n $Namespace -o json
if ($LASTEXITCODE -ne 0) { throw "Deployment $Namespace/$Deployment does not exist." }
$deploymentResource = $deploymentJson | ConvertFrom-Json

$gcloudCommon = @('--project', $ProjectId, '--quiet', '--format=json')
if ($Configuration) { $gcloudCommon = @('--configuration', $Configuration) + $gcloudCommon }
$projectJson = & $gcloud projects describe $ProjectId @gcloudCommon
if ($LASTEXITCODE -ne 0) { throw "Reading Google Cloud project $ProjectId failed." }
$project = $projectJson | ConvertFrom-Json
if ([string]$project.projectNumber -ne $ProjectNumber) {
  throw "Google Cloud project number $($project.projectNumber) does not match declared $ProjectNumber."
}

$clusterJson = & $gcloud container clusters describe $ClusterName --location $Location @gcloudCommon
if ($LASTEXITCODE -ne 0) { throw "Reading GKE cluster $ClusterName failed." }
$cluster = $clusterJson | ConvertFrom-Json
if ($cluster.status -ne 'RUNNING') { throw "GKE cluster $ClusterName is not RUNNING." }
$expectedPool = "$ProjectId.svc.id.goog"
if ($cluster.workloadIdentityConfig.workloadPool -ne $expectedPool) {
  throw "GKE cluster workload pool is not $expectedPool. Enable Workload Identity Federation explicitly at the cluster level."
}

$isAutopilot = $cluster.autopilot.enabled -eq $true
if (($ClusterMode -eq 'autopilot') -ne $isAutopilot) {
  throw "Declared cluster mode $ClusterMode does not match the GKE cluster."
}

$selectorKey = 'iam.gke.io/gke-metadata-server-enabled'
$selectorValue = $deploymentResource.spec.template.spec.nodeSelector.$selectorKey
if ($ClusterMode -eq 'standard') {
  $nodePools = @($cluster.nodePools)
  $unsafePools = @($nodePools | Where-Object { $_.config.workloadMetadataConfig.mode -ne 'GKE_METADATA' })
  if ($nodePools.Count -eq 0 -or $unsafePools.Count -gt 0) {
    throw 'Every Standard GKE node pool must use workloadMetadataConfig.mode=GKE_METADATA before Argus binds cloud IAM.'
  }
  if ($selectorValue -ne 'true') {
    if (-not $PatchNodeSelector) {
      throw "Deployment is missing nodeSelector $selectorKey=true. Re-run with -PatchNodeSelector after reviewing the scheduling change."
    }
    if ($PSCmdlet.ShouldProcess("$Context/$Namespace/$Deployment", "Set nodeSelector $selectorKey=true")) {
      $patch = @{ spec = @{ template = @{ spec = @{ nodeSelector = @{ $selectorKey = 'true' } } } } } | ConvertTo-Json -Depth 8 -Compress
      & $kubectl --context $Context patch deployment $Deployment -n $Namespace --type merge --patch $patch
      if ($LASTEXITCODE -ne 0) { throw 'Patching the GKE metadata-server node selector failed.' }
    }
  }
} elseif ($selectorValue) {
  throw "Autopilot rejects the Standard-only nodeSelector $selectorKey. Remove it explicitly before certification."
}

$principal = "principal://iam.googleapis.com/projects/$ProjectNumber/locations/global/workloadIdentityPools/$expectedPool/kubernetes.serviceaccount.uid/$serviceAccountUid"
$iamPolicyJson = & $gcloud projects get-iam-policy $ProjectId @gcloudCommon
if ($LASTEXITCODE -ne 0) { throw "Reading IAM policy for $ProjectId failed." }
$iamPolicy = $iamPolicyJson | ConvertFrom-Json
$missingRoles = @()
foreach ($role in $RequiredRoles) {
  $matchingBindings = @($iamPolicy.bindings | Where-Object { $_.role -eq $role -and @($_.members) -contains $principal })
  if ($matchingBindings.Count -eq 0) { $missingRoles += $role }
}

if ($missingRoles.Count -gt 0 -and -not $AddIamBindings) {
  throw "Missing IAM bindings for the exact ServiceAccount UID principal: $($missingRoles -join ', '). Re-run with -AddIamBindings after reviewing the roles."
}
foreach ($role in $missingRoles) {
  if ($PSCmdlet.ShouldProcess("Google Cloud project $ProjectId", "Grant $role to $principal")) {
    $bindingArguments = @('projects', 'add-iam-policy-binding', $ProjectId, '--member', $principal, '--role', $role, '--condition=None', '--quiet')
    if ($Configuration) { $bindingArguments += @('--configuration', $Configuration) }
    & $gcloud @bindingArguments
    if ($LASTEXITCODE -ne 0) { throw "Adding IAM role $role failed." }
    Write-Host "Granted $role to the exact ServiceAccount UID principal."
  }
}

if ($RestartDeployment -and $PSCmdlet.ShouldProcess("$Context/$Namespace/$Deployment", 'Restart connector Pods')) {
  & $kubectl --context $Context rollout restart deployment/$Deployment -n $Namespace
  if ($LASTEXITCODE -ne 0) { throw 'Connector rollout restart failed.' }
  & $kubectl --context $Context rollout status deployment/$Deployment -n $Namespace --timeout=5m
  if ($LASTEXITCODE -ne 0) { throw 'Connector Pods did not become ready after the GKE identity update.' }
}

Write-Host ''
Write-Host 'GKE Workload Identity Federation is ready for connector certification.'
Write-Host "ServiceAccount UID: $serviceAccountUid"
Write-Host "IAM principal: $principal"
