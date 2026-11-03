[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ApiKeyFile,
  [string]$ClusterName = 'argus-aiops',
  [string]$CoreUrl = 'http://host.docker.internal:3000',
  [string]$Schedule = '17 */6 * * *',
  [switch]$RunNow
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$labRoot = Join-Path $repoRoot 'demo\aiops\kubernetes'
$contract = Join-Path $labRoot 'connector-contract.in-cluster.json'
$manifest = Join-Path $labRoot 'certification-cronjob.yaml'
$dockerfile = Join-Path $labRoot 'certifier\Dockerfile'
$context = "kind-$ClusterName"
$image = 'argus-kubernetes-certifier:local'

function Resolve-ArgusCommand([string]$Name) {
  $wingetLink = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\$Name.exe"
  if (Test-Path -LiteralPath $wingetLink) { return $wingetLink }
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "$Name is required but was not found in PATH." }
  return $command.Source
}

$resolvedApiKeyFile = (Resolve-Path -LiteralPath $ApiKeyFile).Path
if ((Get-Item -LiteralPath $resolvedApiKeyFile).Length -lt 16) {
  throw 'The API key file is empty or too short.'
}
if (($Schedule -split '\s+').Count -ne 5) {
  throw 'Schedule must be a five-field Kubernetes cron expression.'
}
$coreUri = [Uri]$CoreUrl
if ($coreUri.Scheme -notin @('http', 'https') -or -not $coreUri.Host) {
  throw 'CoreUrl must be an absolute HTTP(S) URL.'
}

$docker = Resolve-ArgusCommand 'docker'
$kind = Resolve-ArgusCommand 'kind'
$kubectl = Resolve-ArgusCommand 'kubectl'
$contexts = @(& $kubectl config get-contexts -o name)
if ($contexts -notcontains $context) {
  throw "Kubernetes context $context does not exist."
}

Write-Host '[kubernetes-certifier] Building the immutable runner image...'
& $docker build --file $dockerfile --tag $image $repoRoot
if ($LASTEXITCODE -ne 0) { throw 'Certifier image build failed.' }
& $kind load docker-image $image --name $ClusterName
if ($LASTEXITCODE -ne 0) { throw 'Loading the certifier image into Kind failed.' }

Write-Host '[kubernetes-certifier] Publishing configuration and the scoped Core credential...'
$configMap = & $kubectl --context $context -n argus-aiops-system create configmap argus-kubernetes-certifier `
  --from-file="connector-contract.json=$contract" `
  --from-literal="core-url=$CoreUrl" `
  --dry-run=client -o yaml
if ($LASTEXITCODE -ne 0) { throw 'ConfigMap rendering failed.' }
$configMap | & $kubectl --context $context apply -f -
if ($LASTEXITCODE -ne 0) { throw 'ConfigMap reconciliation failed.' }

$secret = & $kubectl --context $context -n argus-aiops-system create secret generic argus-kubernetes-certifier-core `
  --from-file="api-key=$resolvedApiKeyFile" `
  --dry-run=client -o yaml
if ($LASTEXITCODE -ne 0) { throw 'Secret rendering failed.' }
$secret | & $kubectl --context $context apply -f -
if ($LASTEXITCODE -ne 0) { throw 'Secret reconciliation failed.' }

& $kubectl --context $context apply -f $manifest
if ($LASTEXITCODE -ne 0) { throw 'CronJob reconciliation failed.' }
$schedulePatch = @{ spec = @{ schedule = $Schedule } } | ConvertTo-Json -Compress
$schedulePatchFile = New-TemporaryFile
try {
  Set-Content -LiteralPath $schedulePatchFile.FullName -Value $schedulePatch -Encoding ascii
  & $kubectl --context $context -n argus-aiops-system patch cronjob argus-kubernetes-certifier `
    --type merge --patch-file $schedulePatchFile.FullName
  if ($LASTEXITCODE -ne 0) { throw 'CronJob schedule update failed.' }
} finally {
  Remove-Item -LiteralPath $schedulePatchFile.FullName -Force -ErrorAction SilentlyContinue
}

if ($RunNow) {
  $runName = 'argus-kubernetes-certifier-manual-' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  & $kubectl --context $context -n argus-aiops-system create job --from=cronjob/argus-kubernetes-certifier $runName
  if ($LASTEXITCODE -ne 0) { throw 'Manual certification Job creation failed.' }
  & $kubectl --context $context -n argus-aiops-system wait --for=condition=complete "job/$runName" --timeout=5m
  $waitExit = $LASTEXITCODE
  & $kubectl --context $context -n argus-aiops-system logs "job/$runName"
  if ($waitExit -ne 0) { throw "Manual certification Job $runName did not complete successfully." }
}

Write-Host ''
Write-Host "Kubernetes connector re-certification is scheduled: $Schedule"
Write-Host 'The Core API key is mounted only into the certifier Pod and is not printed.'
Write-Host 'Inspect jobs with: kubectl -n argus-aiops-system get jobs --selector=app.kubernetes.io/name=argus-kubernetes-certifier'
