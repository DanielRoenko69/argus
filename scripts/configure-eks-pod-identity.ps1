[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)]
  [string]$Context,

  [Parameter(Mandatory = $true)]
  [string]$ClusterName,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$')]
  [string]$Region,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^arn:(aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role/.+$')]
  [string]$RoleArn,

  [string]$Profile,
  [string]$Namespace = 'argus-aiops-system',
  [string]$Deployment = 'argus-kubernetes-connector',
  [string]$ServiceAccount = 'argus-kubernetes-connector',
  [switch]$CreateAssociation,
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

$kubectl = Resolve-ArgusCommand 'kubectl' $env:KUBECTL_BIN
$aws = Resolve-ArgusCommand 'aws' $env:AWS_BIN
$contexts = @(& $kubectl config get-contexts -o name)
if ($contexts -notcontains $Context) { throw "Kubernetes context $Context does not exist." }

$serviceAccountJson = & $kubectl --context $Context get serviceaccount $ServiceAccount -n $Namespace -o json
if ($LASTEXITCODE -ne 0) { throw "ServiceAccount $Namespace/$ServiceAccount does not exist." }
$serviceAccountResource = $serviceAccountJson | ConvertFrom-Json
$irsaRole = $serviceAccountResource.metadata.annotations.'eks.amazonaws.com/role-arn'
if ($irsaRole) {
  throw "ServiceAccount $Namespace/$ServiceAccount still has the IRSA annotation eks.amazonaws.com/role-arn=$irsaRole. Remove or migrate it explicitly before enabling Pod Identity."
}

& $kubectl --context $Context get deployment $Deployment -n $Namespace 1>$null
if ($LASTEXITCODE -ne 0) { throw "Deployment $Namespace/$Deployment does not exist." }

$globalAwsArguments = @('--region', $Region, '--no-cli-pager', '--output', 'json')
if ($Profile) { $globalAwsArguments += @('--profile', $Profile) }
$listArguments = @(
  'eks', 'list-pod-identity-associations',
  '--cluster-name', $ClusterName,
  '--namespace', $Namespace,
  '--service-account', $ServiceAccount
) + $globalAwsArguments
$associationListJson = & $aws @listArguments
if ($LASTEXITCODE -ne 0) { throw 'Listing EKS Pod Identity associations failed.' }
$associations = @(($associationListJson | ConvertFrom-Json).associations)

if ($associations.Count -gt 1) {
  throw "Expected zero or one EKS Pod Identity association for $Namespace/$ServiceAccount, found $($associations.Count)."
}

if ($associations.Count -eq 0) {
  if (-not $CreateAssociation) {
    throw 'No association exists. Re-run with -CreateAssociation after reviewing the IAM role and trust policy.'
  }
  if ($PSCmdlet.ShouldProcess("EKS $ClusterName / $Namespace/$ServiceAccount", "Create Pod Identity association for $RoleArn")) {
    $createArguments = @(
      'eks', 'create-pod-identity-association',
      '--cluster-name', $ClusterName,
      '--namespace', $Namespace,
      '--service-account', $ServiceAccount,
      '--role-arn', $RoleArn
    ) + $globalAwsArguments
    $createdJson = & $aws @createArguments
    if ($LASTEXITCODE -ne 0) { throw 'Creating the EKS Pod Identity association failed.' }
    $created = ($createdJson | ConvertFrom-Json).association
    Write-Host "Created EKS Pod Identity association $($created.associationId)."
  }
} else {
  $associationId = $associations[0].associationId
  $describeArguments = @(
    'eks', 'describe-pod-identity-association',
    '--cluster-name', $ClusterName,
    '--association-id', $associationId
  ) + $globalAwsArguments
  $associationJson = & $aws @describeArguments
  if ($LASTEXITCODE -ne 0) { throw 'Reading the EKS Pod Identity association failed.' }
  $association = ($associationJson | ConvertFrom-Json).association
  if ($association.roleArn -ne $RoleArn) {
    throw "Existing association $associationId uses $($association.roleArn), not the declared role $RoleArn. Refusing to widen or replace IAM access automatically."
  }
  if ($association.disableSessionTags) {
    throw "Existing association $associationId disables session tags; scoped Argus trust-policy certification requires them."
  }
  Write-Host "Existing EKS Pod Identity association $associationId matches the declared role."
}

if ($RestartDeployment -and $PSCmdlet.ShouldProcess("$Context/$Namespace/$Deployment", 'Restart connector Pods so EKS injects Pod Identity credentials')) {
  & $kubectl --context $Context rollout restart deployment/$Deployment -n $Namespace
  if ($LASTEXITCODE -ne 0) { throw 'Connector rollout restart failed.' }
  & $kubectl --context $Context rollout status deployment/$Deployment -n $Namespace --timeout=5m
  if ($LASTEXITCODE -ne 0) { throw 'Connector Pods did not become ready after enabling Pod Identity.' }
}

Write-Host 'EKS Pod Identity configuration is ready for connector certification.'
