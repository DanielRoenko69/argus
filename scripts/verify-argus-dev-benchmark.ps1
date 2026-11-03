param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('nestjs-4873', 'rclone-8675')]
  [string]$Benchmark,

  [Parameter(Mandatory = $true)]
  [string]$RepositoryPath,

  [switch]$InstallDependencies,

  [string]$GoContainerImage = 'argus-core-agent-workspace'
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RepositoryDir = (Resolve-Path -LiteralPath $RepositoryPath).Path
$BenchmarkDir = Join-Path $ProjectDir "demo\argus-dev\$Benchmark"
$ManifestPath = Join-Path $BenchmarkDir 'benchmark.json'

if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  throw "Benchmark manifest not found: $ManifestPath"
}
if (-not (Test-Path -LiteralPath (Join-Path $RepositoryDir '.git'))) {
  throw "RepositoryPath is not a Git checkout: $RepositoryDir"
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$sourceOracle = Join-Path $ProjectDir ([string]$manifest.oracle.behaviorTest)
$targetOracle = [System.IO.Path]::GetFullPath(
  (Join-Path $RepositoryDir ([string]$manifest.oracle.temporaryTarget))
)
$repositoryPrefix = $RepositoryDir.TrimEnd('\') + '\'

if (-not $targetOracle.StartsWith($repositoryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write an oracle outside the repository: $targetOracle"
}
if (Test-Path -LiteralPath $targetOracle) {
  throw "Refusing to overwrite an existing file: $targetOracle"
}

$targetParent = Split-Path -Parent $targetOracle
if (-not (Test-Path -LiteralPath $targetParent -PathType Container)) {
  throw "Oracle target directory does not exist in this checkout: $targetParent"
}

function Invoke-CheckedCommand([string]$Executable, [string[]]$Arguments) {
  Write-Host "[benchmark] $Executable $($Arguments -join ' ')"
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Benchmark command failed with exit code ${LASTEXITCODE}: $Executable"
  }
}

function Invoke-GoCommand([string[]]$Arguments) {
  $go = Get-Command go -ErrorAction SilentlyContinue
  if ($null -ne $go) {
    Invoke-CheckedCommand $go.Source $Arguments
    return
  }

  $docker = Get-Command docker -ErrorAction Stop
  $dockerArguments = @(
    'run', '--rm', '--user', 'root',
    '--mount', "type=bind,source=$RepositoryDir,target=/workspace",
    '--mount', 'type=volume,source=argus-dev-benchmark-gomod,target=/go/pkg/mod',
    '--mount', 'type=volume,source=argus-dev-benchmark-gobuild,target=/root/.cache/go-build',
    '--workdir', '/workspace',
    $GoContainerImage,
    'go'
  ) + $Arguments
  Invoke-CheckedCommand $docker.Source $dockerArguments
}

Push-Location $RepositoryDir
try {
  if ($InstallDependencies) {
    if ($Benchmark -eq 'nestjs-4873') {
      $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
      if ($null -eq $npm) { $npm = Get-Command npm -ErrorAction Stop }
      Invoke-CheckedCommand $npm.Source @(
        'install', '--package-lock=false', '--legacy-peer-deps',
        '--ignore-scripts', '--no-audit', '--no-fund'
      )
    }
    else {
      Invoke-GoCommand @('mod', 'download')
    }
  }

  Copy-Item -LiteralPath $sourceOracle -Destination $targetOracle
  if ($Benchmark -eq 'nestjs-4873') {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npm) { $npm = Get-Command npm -ErrorAction Stop }
    Invoke-CheckedCommand $npm.Source @(
      'exec', '--', 'mocha',
      '--require', 'ts-node/register',
      '--require', 'tsconfig-paths/register',
      '--require', 'node_modules/reflect-metadata/Reflect.js',
      '--require', 'hooks/mocha-init-hook.ts',
      'integration/injector/e2e/argus-race-oracle.spec.ts'
    )
  }
  else {
    Invoke-GoCommand @(
      'test', '-race', './cmd/bisync',
      '-run', '^TestArgusBisyncConcurrent$',
      '-remote', 'local', '-count=1'
    )
  }

  Write-Host "[benchmark] PASS $Benchmark at $(git rev-parse --short HEAD)"
}
finally {
  Pop-Location
  if (Test-Path -LiteralPath $targetOracle) {
    Remove-Item -LiteralPath $targetOracle -Force
  }
}
