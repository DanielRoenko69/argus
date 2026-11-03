param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('nestjs-4873', 'rclone-8675')]
  [string]$Benchmark,

  [string]$PostgresContainer = 'argus-core-postgres-1',

  [string]$CoreContainer = 'argus-core-mcp-server-1',

  [string]$DatabaseUser = 'aiops',

  [string]$DatabaseName = 'aiops'
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ManifestPath = Join-Path $ProjectDir "demo\argus-dev\$Benchmark\benchmark.json"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker is required to provision the local Argus benchmark bundle.'
}
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  throw "Benchmark manifest not found: $ManifestPath"
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$repositoryUri = [System.Uri]([string]$manifest.repository.local)
$repositoryParts = $repositoryUri.AbsolutePath.Trim('/').Split('/')
if ($repositoryParts.Count -ne 2) {
  throw "Expected the local repository URL to contain owner/repository: $($manifest.repository.local)"
}

$owner = $repositoryParts[0]
$repository = $repositoryParts[1] -replace '\.git$', ''
$backendName = "gitea_$($Benchmark.Replace('-', '_'))"
$bundleName = "argus-dev-$Benchmark"
$bundleLabel = switch ($Benchmark) {
  'nestjs-4873' { 'Argus.Dev NestJS #4873' }
  'rclone-8675' { 'Argus.Dev rclone #8675' }
}
$bundleDescription = "Repository-scoped Gitea tools for the Argus.Dev $Benchmark real-project benchmark."

function ConvertTo-SqlLiteral([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

$sourceBackendCount = [string](& docker exec $PostgresContainer psql `
  -U $DatabaseUser -d $DatabaseName -Atqc "SELECT COUNT(*) FROM mcp_backends WHERE name='gitea_local'")
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the local Argus database.' }
if ($sourceBackendCount.Trim() -ne '1') {
  throw "The trusted local backend 'gitea_local' must exist before provisioning a benchmark bundle."
}

$backendSql = ConvertTo-SqlLiteral $backendName
$bundleSql = ConvertTo-SqlLiteral $bundleName
$labelSql = ConvertTo-SqlLiteral $bundleLabel
$descriptionSql = ConvertTo-SqlLiteral $bundleDescription
$ownerSql = ConvertTo-SqlLiteral $owner
$repositorySql = ConvertTo-SqlLiteral $repository

$sql = @"
BEGIN;

INSERT INTO mcp_service_bundles (name, label, description, icon)
VALUES ($bundleSql, $labelSql, $descriptionSql, 'code')
ON CONFLICT (name) DO UPDATE SET
  label=EXCLUDED.label,
  description=EXCLUDED.description,
  icon=EXCLUDED.icon,
  updated_at=NOW();

INSERT INTO mcp_backends (
  name, description, base_url, auth_type, auth_value, health_path,
  default_headers, timeout_ms, tls_skip_verify, enabled, backend_type,
  mcp_endpoint, builtin_key, config
)
SELECT $backendSql,
       $descriptionSql,
       base_url, auth_type, auth_value, health_path, default_headers,
       timeout_ms, tls_skip_verify, true, backend_type, mcp_endpoint, NULL,
       config || jsonb_build_object(
         'owner', $ownerSql::text,
         'repo_slug', $repositorySql::text,
         'repo', $repositorySql::text,
         'default_target_branch', 'main'
       )
  FROM mcp_backends
 WHERE name='gitea_local'
ON CONFLICT (name) DO UPDATE SET
  description=EXCLUDED.description,
  base_url=EXCLUDED.base_url,
  auth_type=EXCLUDED.auth_type,
  auth_value=EXCLUDED.auth_value,
  health_path=EXCLUDED.health_path,
  default_headers=EXCLUDED.default_headers,
  timeout_ms=EXCLUDED.timeout_ms,
  tls_skip_verify=EXCLUDED.tls_skip_verify,
  enabled=true,
  backend_type=EXCLUDED.backend_type,
  config=EXCLUDED.config,
  updated_at=NOW();

INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
SELECT backend.id, bundle.id
  FROM mcp_backends backend
 CROSS JOIN mcp_service_bundles bundle
 WHERE backend.name=$backendSql AND bundle.name=$bundleSql
ON CONFLICT DO NOTHING;

INSERT INTO mcp_bundle_backend_tool_policies (backend_id, bundle_id, mode, allowed_tool_names)
SELECT backend.id, bundle.id, 'all', '{}'
  FROM mcp_backends backend
 CROSS JOIN mcp_service_bundles bundle
 WHERE backend.name=$backendSql AND bundle.name=$bundleSql
ON CONFLICT (backend_id, bundle_id) DO UPDATE SET
  mode='all',
  allowed_tool_names='{}',
  updated_at=NOW();

COMMIT;

SELECT bundle.id AS bundle_id,
       bundle.name AS bundle_name,
       backend.id AS backend_id,
       backend.name AS backend_name,
       backend.config->>'owner' AS owner,
       backend.config->>'repo_slug' AS repository
  FROM mcp_service_bundles bundle
  JOIN mcp_backend_bundles assignment ON assignment.bundle_id=bundle.id
  JOIN mcp_backends backend ON backend.id=assignment.backend_id
 WHERE bundle.name=$bundleSql AND backend.name=$backendSql;
"@

Write-Host "[benchmark] Provisioning $bundleName for $owner/$repository..."
& docker exec $PostgresContainer psql -v ON_ERROR_STOP=1 -U $DatabaseUser -d $DatabaseName -c $sql
if ($LASTEXITCODE -ne 0) { throw "Provisioning failed for benchmark $Benchmark." }

$runningCore = [string](& docker inspect -f '{{.State.Running}}' $CoreContainer 2>$null)
if ($LASTEXITCODE -eq 0 -and $runningCore.Trim() -eq 'true') {
  Write-Host '[benchmark] Restarting Argus Core to reload the backend registry...'
  & docker restart $CoreContainer | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Argus Core restart failed after provisioning.' }
}
else {
  Write-Warning "Argus Core container '$CoreContainer' is not running. Start it before using the bundle."
}

Write-Host "[benchmark] Bundle ready: $bundleName"
