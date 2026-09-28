param([Parameter(Mandatory=$true)][string]$ReceiptRoot)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Disposable CI only' }
New-Item -ItemType Directory -Path $ReceiptRoot | Out-Null
$bootstrapper = Join-Path $ReceiptRoot 'vs_BuildTools.exe'
$url = 'https://download.visualstudio.microsoft.com/download/pr/bc92e2cb-33de-4a0c-995d-efa817f16b16/37bb0fb429d163ecebd272a865d11a37b906d152bef960da2ddb29c2e2fd6eeb/vs_BuildTools.exe'
& "$env:WINDIR\System32\curl.exe" --fail --location --connect-timeout 15 --max-time 90 --max-filesize 33554432 --output $bootstrapper $url
if ($LASTEXITCODE -ne 0) { throw 'Bootstrapper download failed' }
& "$PSScriptRoot\inspect-bootstrapper.ps1" -Bootstrapper $bootstrapper -Receipt (Join-Path $ReceiptRoot 'bootstrapper-identity.json')
$letter = @('R','S','T','U','V','W','X','Y','Z') | Where-Object { !(Test-Path "${_}:\") } | Select-Object -First 1
if (!$letter) { throw 'No unused drive letter' }
$vhd = Join-Path $ReceiptRoot 'sdk-layout.vhdx'
$mount = "${letter}:\"
@("create vdisk file=`"$vhd`" maximum=4096 type=expandable", "select vdisk file=`"$vhd`"", 'attach vdisk', 'create partition primary', 'format fs=ntfs quick label=OrcaSdkProbe', "assign letter=$letter") | Set-Content (Join-Path $ReceiptRoot 'create-disk.txt')
& "$env:WINDIR\System32\diskpart.exe" /s (Join-Path $ReceiptRoot 'create-disk.txt') | Set-Content (Join-Path $ReceiptRoot 'diskpart.log')
if ($LASTEXITCODE -ne 0 -or !(Test-Path $mount)) { throw 'Bounded scratch volume creation failed' }
@{vhd=$vhd;mount=$mount} | ConvertTo-Json | Set-Content (Join-Path $ReceiptRoot 'mount.json')
$layout = Join-Path $mount 'layout'
$temp = Join-Path $mount 'temp'
New-Item -ItemType Directory -Path $temp,$layout | Out-Null
$originalTemp = $env:TEMP
$env:TEMP = $temp
$env:TMP = $temp
$components = @('Microsoft.VisualStudio.Component.Windows11SDK.26100','Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64','Microsoft.VisualStudio.Component.VC.14.44.17.14.ARM64','Microsoft.VisualStudio.Component.VC.14.44.17.14.ATL','Microsoft.VisualStudio.Component.VC.14.44.17.14.ATL.ARM64')
$arguments = @('--layout', $layout, '--lang', 'en-US', '--quiet', '--wait')
foreach ($component in $components) { $arguments += @('--add', $component) }
$arguments | ConvertTo-Json | Set-Content (Join-Path $ReceiptRoot 'arguments.json')
$cache = Join-Path $env:ProgramData 'Microsoft\VisualStudio\Packages'
function Get-CacheBytes {
  if (!(Test-Path $cache)) { return 0L }
  return [long](Get-ChildItem -LiteralPath $cache -File -Recurse -ErrorAction Stop | Measure-Object Length -Sum).Sum
}
$initialCacheBytes = Get-CacheBytes
$process = $null
$started = [DateTime]::UtcNow
function Assert-AcquisitionBudget {
  $layoutFiles = @(Get-ChildItem -LiteralPath $layout -File -Recurse -Force -ErrorAction Stop)
  $tempFiles = @(Get-ChildItem -LiteralPath $temp -File -Recurse -Force -ErrorAction Stop)
  $layoutBytes = [long]($layoutFiles | Measure-Object Length -Sum).Sum
  $tempBytes = [long]($tempFiles | Measure-Object Length -Sum).Sum
  $externalGrowth = [Math]::Max(0, (Get-CacheBytes) - $initialCacheBytes)
  $elapsed = ([DateTime]::UtcNow - $started).TotalSeconds
  $reasons = @()
  if (($layoutBytes + $tempBytes + $externalGrowth) -gt 4GB) { $reasons += 'aggregate-bytes' }
  if ($layoutFiles.Count -gt 1000) { $reasons += 'layout-payload-count' }
  if ($tempFiles.Count -gt 10000) { $reasons += 'temporary-extraction-count' }
  if ($elapsed -gt 2700) { $reasons += 'elapsed-time' }
  $budget = [ordered]@{
    observedAt=[DateTime]::UtcNow.ToString('o'); elapsedSeconds=$elapsed
    layoutFiles=$layoutFiles.Count; temporaryFiles=$tempFiles.Count
    layoutBytes=$layoutBytes; temporaryBytes=$tempBytes; externalCacheGrowthBytes=$externalGrowth
    aggregateBytes=($layoutBytes+$tempBytes+$externalGrowth)
    byteLimit=4GB; layoutFileLimit=1000; temporaryFileLimit=10000; secondsLimit=2700
    exceeded=$reasons
  }
  $budget | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $ReceiptRoot 'budget-latest.json')
  if ($reasons.Count -gt 0) {
    $budget | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $ReceiptRoot 'budget-exceeded.json')
    throw ('Layout acquisition budget exceeded: ' + ($reasons -join ', '))
  }
}
try {
  $process = Start-Process -FilePath $bootstrapper -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $ReceiptRoot 'bootstrapper-stdout.txt') -RedirectStandardError (Join-Path $ReceiptRoot 'bootstrapper-stderr.txt')
  while (!$process.WaitForExit(2000)) {
    Assert-AcquisitionBudget
  }
  $process.Refresh()
  if ($process.ExitCode -ne 0) { throw "Layout acquisition failed: $($process.ExitCode)" }
  Assert-AcquisitionBudget
  $catalog = Join-Path $layout 'Catalog.json'
  if (!(Test-Path $catalog)) { throw 'Supported layout omitted Catalog.json' }
  Copy-Item -LiteralPath $catalog -Destination (Join-Path $ReceiptRoot 'Catalog.json')
  $catalogHash = (Get-FileHash -LiteralPath $catalog -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($catalogHash -ne 'f0a50ea157222c29abd5ea6ff01bfc3c33b04e011c5e45ee2ca38ef0778e5643') { throw "Catalog drift; new input qualification required: $catalogHash" }
  $inventory = foreach ($file in Get-ChildItem -LiteralPath $layout -File -Recurse) {
    [ordered]@{path=$file.FullName.Substring($layout.Length+1);bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
  }
  $inventory | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $ReceiptRoot 'layout-inventory.json')
  [ordered]@{acquired=$true;productInstalled=$false;offlineVerificationPerformed=$false;manifestSignatureVerified=$false;catalogSha256=$catalogHash;components=$components} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $ReceiptRoot 'result.json')
} finally {
  if ($process -and !$process.HasExited) {
    & "$env:WINDIR\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
    $killCode=$LASTEXITCODE
    $exited=$process.WaitForExit(10000)
    @{taskkillExitCode=$killCode;bootstrapperExited=$exited;descendantExitVerified=$false} | ConvertTo-Json | Set-Content (Join-Path $ReceiptRoot 'termination.json')
    if ($killCode -ne 0 -or !$exited) { Write-Warning 'Process cleanup unverified; discard disposable runner' }
  }
  $logRoot = Join-Path $ReceiptRoot 'setup-logs'
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  $logIndex = @()
  $logBytes = 0L
  foreach ($root in (@($temp, $originalTemp, (Join-Path $env:WINDIR 'Temp')) | Select-Object -Unique)) {
    if (!(Test-Path -LiteralPath $root)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $root -Filter 'dd_*' -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -ge $started }) {
      if ($logIndex.Count -ge 100 -or ($logBytes + $file.Length) -gt 64MB) { Write-Warning 'Setup log retention budget reached'; break }
      $name = '{0:D3}-{1}' -f $logIndex.Count, $file.Name
      Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $logRoot $name) -ErrorAction Continue
      $logIndex += @{source=$file.FullName;receipt=$name;bytes=$file.Length}
      $logBytes += $file.Length
    }
  }
  $logIndex | ConvertTo-Json | Set-Content (Join-Path $ReceiptRoot 'setup-log-index.json')
  "layout_path=$layout" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
}
