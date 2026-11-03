[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)]
  [string]$Context,

  [string]$Namespace = 'argus-aiops-system',
  [string]$Deployment = 'argus-kubernetes-connector',
  [string]$Service = 'argus-kubernetes-connector',
  [string]$ServiceAccount = 'argus-kubernetes-connector',
  [string]$ServingCertificateSecret = 'argus-kubernetes-connector-tls',
  [string]$TlsContainer = 'tls-proxy',
  [string]$TlsImage = 'docker.io/nginxinc/nginx-unprivileged:1.28-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8',
  [string]$TlsMountPath = '/var/run/secrets/argus-serving-cert',
  [ValidatePattern('^[0-9]+\.[0-9]+$')]
  [string]$MinimumVersion = '4.14',
  [ValidateSet('restricted-v2', 'restricted-v3')]
  [string[]]$AllowedSccs = @('restricted-v2', 'restricted-v3'),
  [switch]$RequestServingCertificate,
  [switch]$RestartDeployment
)

$ErrorActionPreference = 'Stop'
$forbiddenSccs = @('anyuid', 'hostaccess', 'hostmount-anyuid', 'hostnetwork', 'node-exporter', 'privileged')

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

function Test-VersionAtLeast([string]$Actual, [string]$Minimum) {
  $actualParts = @($Actual.Split('.') | ForEach-Object { [int]$_ })
  $minimumParts = @($Minimum.Split('.') | ForEach-Object { [int]$_ })
  $length = [Math]::Max($actualParts.Count, $minimumParts.Count)
  for ($index = 0; $index -lt $length; $index++) {
    $actualPart = if ($index -lt $actualParts.Count) { $actualParts[$index] } else { 0 }
    $minimumPart = if ($index -lt $minimumParts.Count) { $minimumParts[$index] } else { 0 }
    if ($actualPart -gt $minimumPart) { return $true }
    if ($actualPart -lt $minimumPart) { return $false }
  }
  return $true
}

function Get-ConditionStatus($Resource, [string]$Type) {
  return [string](($Resource.status.conditions | Where-Object { $_.type -eq $Type } | Select-Object -First 1).status)
}

$kubectl = Resolve-ArgusCommand 'kubectl' $env:KUBECTL_BIN
$contexts = @(& $kubectl config get-contexts -o name)
if ($contexts -notcontains $Context) { throw "Kubernetes context $Context does not exist." }

$clusterVersionJson = & $kubectl --context $Context get clusterversion.config.openshift.io version -o json
if ($LASTEXITCODE -ne 0) { throw 'This context does not expose the OpenShift ClusterVersion API.' }
$clusterVersion = $clusterVersionJson | ConvertFrom-Json
$actualVersion = [string]$clusterVersion.status.desired.version
if (-not (Test-VersionAtLeast $actualVersion $MinimumVersion)) { throw "OpenShift $actualVersion is below required $MinimumVersion." }
if ($clusterVersion.metadata.generation -ne $clusterVersion.status.observedGeneration) { throw 'OpenShift ClusterVersion conditions are stale.' }
if ((Get-ConditionStatus $clusterVersion 'Available') -ne 'True') { throw 'OpenShift ClusterVersion is not Available.' }
if ((Get-ConditionStatus $clusterVersion 'Progressing') -ne 'False') { throw 'OpenShift ClusterVersion is still Progressing.' }
if ((Get-ConditionStatus $clusterVersion 'Degraded') -eq 'True' -or (Get-ConditionStatus $clusterVersion 'Failing') -eq 'True') {
  throw 'OpenShift ClusterVersion is degraded or failing.'
}

$namespaceJson = & $kubectl --context $Context get namespace $Namespace -o json
if ($LASTEXITCODE -ne 0) { throw "Namespace $Namespace does not exist." }
$namespaceResource = $namespaceJson | ConvertFrom-Json
if ($namespaceResource.metadata.labels.'openshift.io/run-level') { throw "Namespace $Namespace has the forbidden openshift.io/run-level label." }
if ($namespaceResource.metadata.labels.'pod-security.kubernetes.io/enforce' -eq 'privileged') { throw "Namespace $Namespace enforces the privileged Pod Security profile." }

$serviceAccountJson = & $kubectl --context $Context get serviceaccount $ServiceAccount -n $Namespace -o json
if ($LASTEXITCODE -ne 0) { throw "ServiceAccount $Namespace/$ServiceAccount does not exist." }
$serviceAccountResource = $serviceAccountJson | ConvertFrom-Json
$oauthAnnotations = @($serviceAccountResource.metadata.annotations.psobject.Properties | Where-Object { $_.Name.StartsWith('serviceaccounts.openshift.io/oauth-') })
if ($oauthAnnotations.Count -gt 0) { throw 'Connector ServiceAccount has OpenShift OAuth annotations and cannot be certified as an internal connector identity.' }

$identity = "system:serviceaccount:$Namespace`:$ServiceAccount"
foreach ($scc in $forbiddenSccs) {
  $answer = & $kubectl --context $Context auth can-i use "securitycontextconstraints.security.openshift.io/$scc" "--as=$identity"
  if ($LASTEXITCODE -notin @(0, 1)) { throw "Unable to evaluate SCC permission $scc." }
  if ([string]$answer -eq 'yes') { throw "Connector ServiceAccount can use forbidden SCC $scc." }
}

$deploymentJson = & $kubectl --context $Context get deployment $Deployment -n $Namespace -o json
if ($LASTEXITCODE -ne 0) { throw "Deployment $Namespace/$Deployment does not exist." }
$deploymentResource = $deploymentJson | ConvertFrom-Json
$serviceJson = & $kubectl --context $Context get service $Service -n $Namespace -o json
if ($LASTEXITCODE -ne 0) { throw "Service $Namespace/$Service does not exist." }
$serviceResource = $serviceJson | ConvertFrom-Json

$currentSecretName = [string]$serviceResource.metadata.annotations.'service.beta.openshift.io/serving-cert-secret-name'
if ($currentSecretName -ne $ServingCertificateSecret) {
  if (-not $RequestServingCertificate) {
    throw "Service does not request serving certificate $ServingCertificateSecret. Re-run with -RequestServingCertificate after reviewing the change."
  }
  if ($PSCmdlet.ShouldProcess("$Context/$Namespace/$Service", "Request OpenShift service-ca certificate $ServingCertificateSecret")) {
    & $kubectl --context $Context annotate service $Service -n $Namespace `
      "service.beta.openshift.io/serving-cert-secret-name=$ServingCertificateSecret" --overwrite
    if ($LASTEXITCODE -ne 0) { throw 'Requesting the OpenShift service serving certificate failed.' }
    & $kubectl --context $Context wait --for=create "secret/$ServingCertificateSecret" -n $Namespace --timeout=60s
    if ($LASTEXITCODE -ne 0) { throw 'OpenShift service-ca did not create the serving certificate Secret in time.' }
  }
}

$secretJson = & $kubectl --context $Context get secret $ServingCertificateSecret -n $Namespace -o json
if ($LASTEXITCODE -ne 0) { throw "Serving certificate Secret $Namespace/$ServingCertificateSecret does not exist." }
$secretResource = $secretJson | ConvertFrom-Json
if ($secretResource.type -ne 'kubernetes.io/tls' -or -not $secretResource.data.'tls.crt' -or -not $secretResource.data.'tls.key') {
  throw 'Serving certificate Secret is not a complete kubernetes.io/tls Secret.'
}

$volumes = @($deploymentResource.spec.template.spec.volumes)
$servingVolume = $volumes | Where-Object { $_.secret.secretName -eq $ServingCertificateSecret } | Select-Object -First 1
if (-not $servingVolume) { throw 'Deployment does not mount the OpenShift serving certificate Secret.' }
$tlsContainerResource = $deploymentResource.spec.template.spec.containers | Where-Object { $_.name -eq $TlsContainer } | Select-Object -First 1
if (-not $tlsContainerResource) { throw "Deployment does not contain TLS container $TlsContainer." }
if ($tlsContainerResource.image -ne $TlsImage) { throw "TLS container image is not pinned to the declared image $TlsImage." }
$tlsMount = $tlsContainerResource.volumeMounts | Where-Object { $_.name -eq $servingVolume.name } | Select-Object -First 1
if (-not $tlsMount -or $tlsMount.mountPath -ne $TlsMountPath -or $tlsMount.readOnly -ne $true) {
  throw "TLS container must mount the serving certificate read-only at $TlsMountPath."
}
$tlsSecurity = $tlsContainerResource.securityContext
if ($tlsSecurity.runAsNonRoot -ne $true -or
    $tlsSecurity.allowPrivilegeEscalation -ne $false -or
    $tlsSecurity.privileged -eq $true -or
    $tlsSecurity.readOnlyRootFilesystem -ne $true -or
    @($tlsSecurity.capabilities.drop) -notcontains 'ALL') {
  throw 'TLS container must run non-root, forbid privilege escalation, use a read-only root filesystem and drop all capabilities.'
}
$toolsContainer = $deploymentResource.spec.template.spec.containers | Where-Object { $_.name -eq 'tools' } | Select-Object -First 1
$toolsMount = $toolsContainer.volumeMounts | Where-Object { $_.name -eq $servingVolume.name } | Select-Object -First 1
if ($toolsMount) { throw 'The MCP tools container must not mount the TLS private key.' }

$selectorParts = @($deploymentResource.spec.selector.matchLabels.psobject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" })
$podsJson = & $kubectl --context $Context get pods -n $Namespace -l ($selectorParts -join ',') -o json
if ($LASTEXITCODE -ne 0) { throw 'Reading connector Pods failed.' }
$pods = @((($podsJson | ConvertFrom-Json).items))
if ($pods.Count -eq 0) { throw 'No connector Pods are running.' }
foreach ($pod in $pods) {
  $scc = [string]$pod.metadata.annotations.'openshift.io/scc'
  if ($scc -notin $AllowedSccs) { throw "Pod $($pod.metadata.name) was admitted by unexpected SCC $scc." }
}

$routesJson = & $kubectl --context $Context get routes.route.openshift.io -n $Namespace -o json
if ($LASTEXITCODE -ne 0) { throw 'Reading OpenShift Routes failed.' }
$routes = @((($routesJson | ConvertFrom-Json).items))
$connectorRoutes = @($routes | Where-Object {
  ($_.spec.to.kind -eq 'Service' -and $_.spec.to.name -eq $Service) -or
  @($_.spec.alternateBackends | Where-Object { $_.kind -eq 'Service' -and $_.name -eq $Service }).Count -gt 0
})
if ($connectorRoutes.Count -gt 0) { throw 'Connector Service is exposed through an OpenShift Route.' }

if ($RestartDeployment -and $PSCmdlet.ShouldProcess("$Context/$Namespace/$Deployment", 'Restart connector Pods')) {
  & $kubectl --context $Context rollout restart deployment/$Deployment -n $Namespace
  if ($LASTEXITCODE -ne 0) { throw 'Connector rollout restart failed.' }
  & $kubectl --context $Context rollout status deployment/$Deployment -n $Namespace --timeout=5m
  if ($LASTEXITCODE -ne 0) { throw 'Connector Pods did not become ready after restart.' }
}

Write-Host 'OpenShift ServiceAccount, restricted SCC and service-ca TLS boundary are ready for connector certification.'
