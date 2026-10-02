param(
  [Parameter(Mandatory = $true)][ValidateSet('reset', 'start', 'measure')][string]$Phase,
  [Parameter(Mandatory = $true)][ValidateSet('cached', 'registry')][string]$Treatment
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true') {
  throw 'Reset dependencies only on a disposable hosted Windows runner.'
}
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if ($repository -ne [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)) {
  throw 'Benchmark script must run from its own checkout.'
}
$outputDirectory = Join-Path $env:RUNNER_TEMP 'windows-root-store-comparison'
$resultPath = Join-Path $outputDirectory "sample-$env:COST_SAMPLE.json"
$policyFiles = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc')
New-Item -ItemType Directory -Force $outputDirectory | Out-Null

function Get-Digests([string[]]$Files) {
  return @($Files | ForEach-Object {
    $path = Join-Path $repository $_
    if ($_ -eq '.npmrc' -and -not (Test-Path -LiteralPath $path)) {
      "$_=absent"
    } else {
      "$_=$((Get-FileHash -Algorithm SHA256 $path).Hash)"
    }
  }) -join ';'
}

if ($Phase -eq 'reset') {
  $store = (& pnpm store path --silent).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Could not resolve pnpm store.' }
  if (-not [IO.Path]::IsPathRooted($store) -or $store -notmatch '[\\/](?:\.pnpm-store|pnpm[\\/]store)[\\/]v\d+$') {
    throw "Refusing to remove an unexpected store: $store"
  }
  $cache = (& pnpm cache path).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Could not resolve pnpm cache.' }
  $relative = [IO.Path]::GetRelativePath($env:USERPROFILE, $cache)
  if ([IO.Path]::IsPathRooted($relative) -or $relative.StartsWith('..') -or $relative -eq '.' -or $cache -notmatch '[\\/](?:\.?pnpm-cache|pnpm[\\/]cache)$') {
    throw "Refusing to remove an unexpected cache: $cache"
  }
  foreach ($path in @($store, $cache, (Join-Path $repository 'node_modules'))) {
    if (Test-Path $path) { Remove-Item -LiteralPath $path -Recurse -Force }
  }
  "store=$store" >> $env:GITHUB_OUTPUT
} elseif ($Phase -eq 'start') {
  "started=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" >> $env:GITHUB_OUTPUT
} else {
  $started = [long]$env:COST_STARTED
  if ($started -le 0) { throw 'Missing start timestamp.' }
  if ($Treatment -eq 'cached' -and $env:COST_CACHE_HIT -ne 'true') {
    throw 'Require a real root-only store hit.'
  }
  $policyDigest = Get-Digests $policyFiles
  $timer = [Diagnostics.Stopwatch]::StartNew()
  & pnpm install --frozen-lockfile --ignore-scripts *> (Join-Path $outputDirectory "$Treatment-root.log")
  if ($LASTEXITCODE -ne 0) { throw 'Root frozen installation failed.' }
  $rootInstallMs = $timer.Elapsed.TotalMilliseconds
  $totalMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $started
  if ($policyDigest -ne (Get-Digests $policyFiles)) { throw 'Frozen installation changed policy inputs.' }
  & git diff --exit-code -- $policyFiles
  if ($LASTEXITCODE -ne 0) { throw 'Frozen installation changed tracked policy inputs.' }
  & node -e 'require.resolve("vitest"); require.resolve("electron"); require.resolve("react")'
  if ($LASTEXITCODE -ne 0) { throw 'Installed root packages cannot resolve.' }
  $row = [ordered]@{
    sample = [int]$env:COST_SAMPLE
    treatment = $Treatment
    node = (& node --version)
    policyDigest = $policyDigest
    installedDigest = (Get-Digests @('node_modules/.pnpm/lock.yaml'))
    architecture = (& node -p 'process.arch')
    pnpm = (& pnpm --version)
    rootInstallMs = $rootInstallMs
    restoreAndStepMs = $totalMs - $rootInstallMs
    totalMs = $totalMs
  }
  $previous = @()
  if (Test-Path $resultPath) { $previous = @(Get-Content -Raw $resultPath | ConvertFrom-Json) }
  foreach ($result in $previous) {
    if ($result.policyDigest -ne $row.policyDigest -or $result.installedDigest -ne $row.installedDigest) {
      throw 'Different policies or installed lockfiles across treatments.'
    }
  }
  @($previous + @($row)) | ConvertTo-Json -Depth 4 | Set-Content $resultPath
  $row | ConvertTo-Json -Depth 4
}
