param(
  [switch]$UseGpu,
  [switch]$UseNativeOllama,
  [string]$NativeOllamaModel = 'qwen3.5:9b',
  [string]$NativeOllamaCoderModel = 'qwen3.5:9b',
  [string]$NativeOllamaCoderAlias = 'argus-qwen3.5:9b',
  [ValidateRange(8192, 131072)]
  [int]$NativeOllamaContextLength = 16384,
  [string]$EmbeddingModel = 'qwen3-embedding:0.6b'
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $ProjectDir

function New-HexSecret([int]$Bytes = 24) {
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buffer)
  }
  finally {
    $rng.Dispose()
  }
  return ([BitConverter]::ToString($buffer) -replace '-', '').ToLowerInvariant()
}

function Set-DotEnvValue([string]$Key, [string]$Value) {
  $lines = [System.Collections.Generic.List[string]](Get-Content -LiteralPath '.env')
  $replaced = $false
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match ('^' + [regex]::Escape($Key) + '=')) {
      $lines[$index] = "$Key=$Value"
      $replaced = $true
    }
  }
  if (-not $replaced) {
    $lines.Add("$Key=$Value")
  }
  Set-Content -LiteralPath '.env' -Value $lines -Encoding utf8
}

function Get-DotEnvValue([string]$Key) {
  $match = Get-Content -LiteralPath '.env' |
    Where-Object { $_ -match ('^' + [regex]::Escape($Key) + '=') } |
    Select-Object -Last 1
  if ($null -eq $match) { return '' }
  return $match.Substring($Key.Length + 1)
}

function Ensure-DotEnvSecret(
  [string]$Key,
  [string]$Prefix = '',
  [int]$MinimumLength = 1,
  [int]$Bytes = 24
) {
  $currentValue = Get-DotEnvValue $Key
  if ([string]::IsNullOrWhiteSpace($currentValue) -or $currentValue.Length -lt $MinimumLength) {
    Set-DotEnvValue $Key ($Prefix + (New-HexSecret $Bytes))
  }
}

function Wait-ForLiteLlm([int]$Port, [int]$TimeoutSeconds = 90) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health/liveliness" -TimeoutSec 3 | Out-Null
      return
    }
    catch {
      Start-Sleep -Seconds 2
    }
  } while ((Get-Date) -lt $deadline)
  throw "LiteLLM did not become ready on port $Port within $TimeoutSeconds seconds."
}

function Test-LiteLlmVirtualKey([int]$Port, [string]$Key) {
  if ([string]::IsNullOrWhiteSpace($Key)) { return $false }
  try {
    $catalog = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/models" `
      -Headers @{ Authorization = "Bearer $Key" } -TimeoutSec 10
    $ids = @($catalog.data | ForEach-Object { [string]$_.id })
    foreach ($requiredModel in @('argus-local', 'argus-local-coder', 'argus-local-embedding')) {
      if ($ids -notcontains $requiredModel) { return $false }
    }
    return $true
  }
  catch {
    return $false
  }
}

function Ensure-LiteLlmVirtualKey([int]$Port) {
  $currentKey = Get-DotEnvValue 'ARGUS_LITELLM_API_KEY'
  $masterKey = Get-DotEnvValue 'LITELLM_MASTER_KEY'
  $requiredModels = @('argus-local', 'argus-local-coder', 'argus-local-embedding', 'argus-openai')
  if (Test-LiteLlmVirtualKey $Port $currentKey) {
    Write-Host '[bootstrap] Existing Argus Core LiteLLM Virtual Key is valid.'
    return
  }

  if (-not [string]::IsNullOrWhiteSpace($currentKey)) {
    Write-Host '[bootstrap] Extending the existing Argus Core Virtual Key model scope...'
    $updatePayload = @{
      key = $currentKey
      models = $requiredModels
      max_parallel_requests = 4
      rpm_limit = 120
    } | ConvertTo-Json -Depth 4
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/key/update" `
      -Method Post `
      -Headers @{ Authorization = "Bearer $masterKey" } `
      -ContentType 'application/json' `
      -Body $updatePayload `
      -TimeoutSec 30 | Out-Null
    if (Test-LiteLlmVirtualKey $Port $currentKey) {
      Write-Host '[bootstrap] Existing Argus Core LiteLLM Virtual Key scope updated.'
      return
    }
    throw 'LiteLLM Virtual Key update completed but the required model scope is still missing.'
  }

  $payload = @{
    key_alias = 'argus-core-local'
    models = $requiredModels
    max_parallel_requests = 4
    rpm_limit = 120
    metadata = @{
      application = 'argus-core'
      environment = 'local'
      managed_by = 'bootstrap-local.ps1'
    }
  } | ConvertTo-Json -Depth 5
  $created = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/key/generate" `
    -Method Post `
    -Headers @{ Authorization = "Bearer $masterKey" } `
    -ContentType 'application/json' `
    -Body $payload `
    -TimeoutSec 30
  if ([string]::IsNullOrWhiteSpace([string]$created.key)) {
    throw 'LiteLLM returned no Virtual Key for Argus Core.'
  }
  Set-DotEnvValue 'ARGUS_LITELLM_API_KEY' ([string]$created.key)
  Write-Host '[bootstrap] Created scoped LiteLLM Virtual Key: argus-core-local.'
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker Desktop is required and must be available in PATH.'
}

if ($UseGpu -and $UseNativeOllama) {
  throw 'Use either -UseGpu for containerized NVIDIA Ollama or -UseNativeOllama for host Ollama, not both.'
}

& cmd.exe /d /c 'docker info >nul 2>&1'
if ($LASTEXITCODE -ne 0) {
  throw 'Docker Desktop is installed but the Docker daemon is not running.'
}

if (-not (Test-Path -LiteralPath '.env')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env'
  Set-DotEnvValue 'SESSION_SECRET' (New-HexSecret 32)
  Set-DotEnvValue 'DB_ENCRYPTION_KEY' (New-HexSecret 32)
  $postgresPassword = New-HexSecret 16
  Set-DotEnvValue 'POSTGRES_PASSWORD' $postgresPassword
  Set-DotEnvValue 'POSTGRES_CONNECTION_URL' "postgresql://aiops:$postgresPassword@localhost:5432/aiops"
  Set-DotEnvValue 'MCP_API_KEYS' ('ak_' + (New-HexSecret 32))
  Set-DotEnvValue 'WORKSPACE_SECRET' (New-HexSecret 32)
}

Ensure-DotEnvSecret 'SESSION_SECRET' '' 32 32
Ensure-DotEnvSecret 'DB_ENCRYPTION_KEY' '' 64 32
Ensure-DotEnvSecret 'MCP_API_KEYS' 'ak_' 32 32
Ensure-DotEnvSecret 'WORKSPACE_SECRET' '' 32 32
Ensure-DotEnvSecret 'LITELLM_MASTER_KEY' 'sk-local-' 32 24
Ensure-DotEnvSecret 'LITELLM_UI_PASSWORD' '' 16 24
Ensure-DotEnvSecret 'LITELLM_DATABASE_PASSWORD' '' 16 24
Ensure-DotEnvSecret 'REDIS_PASSWORD' '' 16 24
Ensure-DotEnvSecret 'ARGUS_WEBHOOK_SECRET' '' 32 32

$postgresPassword = Get-DotEnvValue 'POSTGRES_PASSWORD'
$postgresPasswordChanged = $false
if ([string]::IsNullOrWhiteSpace($postgresPassword) -or $postgresPassword.Length -lt 16) {
  $postgresPassword = New-HexSecret 16
  Set-DotEnvValue 'POSTGRES_PASSWORD' $postgresPassword
  $postgresPasswordChanged = $true
}
Set-DotEnvValue 'POSTGRES_CONNECTION_URL' "postgresql://aiops:$postgresPassword@localhost:5432/aiops"
Set-DotEnvValue 'ARGUS_INSTALL_STARTER_AGENTS' 'true'
Set-DotEnvValue 'LLM_REQUEST_TIMEOUT_MS' '300000'

if ($UseNativeOllama) {
  Set-DotEnvValue 'OLLAMA_API_BASE' 'http://host.docker.internal:11434'
  Set-DotEnvValue 'OLLAMA_CONTEXT_LENGTH' ([string]$NativeOllamaContextLength)
  Set-DotEnvValue 'OLLAMA_MODEL' $NativeOllamaCoderAlias
  Set-DotEnvValue 'LITELLM_OLLAMA_MODEL' "ollama_chat/$NativeOllamaCoderAlias"
  Set-DotEnvValue 'LITELLM_OLLAMA_CODER_MODEL' "ollama_chat/$NativeOllamaCoderAlias"
  Set-DotEnvValue 'LITELLM_OLLAMA_EMBEDDING_MODEL' "ollama/$EmbeddingModel"
}
else {
  Set-DotEnvValue 'OLLAMA_API_BASE' 'http://ollama:11434'
  Set-DotEnvValue 'OLLAMA_MODEL' 'granite3.3:2b'
  Set-DotEnvValue 'LITELLM_OLLAMA_MODEL' 'ollama_chat/granite3.3:2b'
  Set-DotEnvValue 'LITELLM_OLLAMA_CODER_MODEL' 'ollama_chat/qwen2.5-coder:3b'
  Set-DotEnvValue 'LITELLM_OLLAMA_EMBEDDING_MODEL' "ollama/$EmbeddingModel"
}

$compose = @('compose')
if ($UseGpu) {
  $compose += @('-f', 'docker-compose.yml', '-f', 'compose.gpu.yml')
}
$compose += @('--profile', 'llm-gateway')
if (-not $UseNativeOllama) {
  $compose += @('--profile', 'local-llm')
}

if ($postgresPasswordChanged) {
  $postgresContainerId = [string](& docker @compose ps -q postgres)
  $postgresContainerId = $postgresContainerId.Trim()
  if (-not [string]::IsNullOrWhiteSpace($postgresContainerId)) {
    Write-Host '[bootstrap] Replacing an insecure local PostgreSQL placeholder password...'
    $escapedPostgresPassword = $postgresPassword.Replace("'", "''")
    & docker exec $postgresContainerId psql -U aiops -d aiops -c "ALTER ROLE aiops WITH PASSWORD '$escapedPostgresPassword';"
    if ($LASTEXITCODE -ne 0) { throw 'Existing local PostgreSQL password rotation failed.' }
  }
}

Write-Host '[bootstrap] Pulling pinned runtime images...'
$runtimeServices = @('postgres', 'redis', 'agent-workspace-db', 'litellm-db', 'litellm')
if (-not $UseNativeOllama) {
  $runtimeServices += 'ollama'
}
& docker @compose pull @runtimeServices
if ($LASTEXITCODE -ne 0) { throw 'Docker image pull failed.' }

if ($UseNativeOllama) {
  Write-Host "[bootstrap] Verifying native Ollama and model $NativeOllamaModel..."
  $ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue
  $ollamaExecutable = if ($null -ne $ollamaCommand) {
    $ollamaCommand.Source
  }
  else {
    Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
  }
  if (-not (Test-Path -LiteralPath $ollamaExecutable)) {
    throw 'Native Ollama is not installed. Install it with: winget install --id Ollama.Ollama --exact'
  }
  try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 5 | Out-Null
  }
  catch {
    throw 'Native Ollama is installed but its API is not running on http://127.0.0.1:11434.'
  }
  & $ollamaExecutable pull $NativeOllamaModel
  if ($LASTEXITCODE -ne 0) { throw "Native Ollama model download failed: $NativeOllamaModel" }
  if ($NativeOllamaCoderModel -ne $NativeOllamaModel) {
    & $ollamaExecutable pull $NativeOllamaCoderModel
    if ($LASTEXITCODE -ne 0) { throw "Native Ollama coder model download failed: $NativeOllamaCoderModel" }
  }
  $coderAliasPayload = @{
    model = $NativeOllamaCoderAlias
    from = $NativeOllamaCoderModel
    parameters = @{ num_ctx = $NativeOllamaContextLength }
    stream = $false
  } | ConvertTo-Json -Depth 4
  Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/create' `
    -Method Post `
    -ContentType 'application/json' `
    -Body $coderAliasPayload `
    -TimeoutSec 120 | Out-Null
  Write-Host "[bootstrap] Created $NativeOllamaCoderAlias with a $NativeOllamaContextLength-token context window."
  & $ollamaExecutable pull $EmbeddingModel
  if ($LASTEXITCODE -ne 0) { throw "Native Ollama embedding model download failed: $EmbeddingModel" }
}
else {
  Write-Host '[bootstrap] Starting containerized Ollama and downloading local models...'
  & docker @compose up -d ollama
  if ($LASTEXITCODE -ne 0) { throw 'Ollama startup failed.' }
  & docker @compose exec -T ollama ollama pull granite3.3:2b
  if ($LASTEXITCODE -ne 0) { throw 'Granite model download failed.' }
  & docker @compose exec -T ollama ollama pull qwen2.5-coder:3b
  if ($LASTEXITCODE -ne 0) { throw 'Qwen Coder model download failed.' }
  & docker @compose exec -T ollama ollama pull $EmbeddingModel
  if ($LASTEXITCODE -ne 0) { throw "Embedding model download failed: $EmbeddingModel" }
}

Write-Host '[bootstrap] Starting LiteLLM and provisioning the Argus Core runtime key...'
& docker @compose up -d litellm
if ($LASTEXITCODE -ne 0) { throw 'LiteLLM startup failed.' }
$litellmPortValue = Get-DotEnvValue 'LITELLM_PORT'
$litellmPort = if ($litellmPortValue -match '^\d+$') { [int]$litellmPortValue } else { 4000 }
Wait-ForLiteLlm $litellmPort
Ensure-LiteLlmVirtualKey $litellmPort
$runtimeKey = Get-DotEnvValue 'ARGUS_LITELLM_API_KEY'
Set-DotEnvValue 'OPENAI_BASE_URL' 'http://litellm:4000/v1'
Set-DotEnvValue 'OPENAI_API_KEY' $runtimeKey
Set-DotEnvValue 'EMBEDDING_MODEL' 'argus-local-embedding'
Set-DotEnvValue 'ARGUS_AGENT_MEMORY_AUTO_ENABLED' 'true'
Set-DotEnvValue 'ARGUS_CODE_EMBEDDING_PROFILE' 'qwen3-code-retrieval'
Set-DotEnvValue 'ARGUS_CODE_EMBEDDINGS_ENABLED' 'true'
Set-DotEnvValue 'ARGUS_CODE_EMBEDDING_MODEL' 'argus-local-embedding'

Write-Host '[bootstrap] Building Argus images and starting the complete local stack...'
& docker @compose up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Argus stack startup failed.' }

& docker @compose ps
Write-Host '[bootstrap] Argus Core: http://localhost:3000'
Write-Host '[bootstrap] LiteLLM UI: http://localhost:4000/ui'
Write-Host '[bootstrap] Use -UseNativeOllama on Windows AMD hosts to keep inference on the native GPU runtime.'
Write-Host '[bootstrap] Add -UseGpu on NVIDIA/WSL2 hosts with GPU-enabled Docker Desktop.'
