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
New-Item -ItemType Directory -Path $temp | Out-Null
$env:TEMP = $temp
$env:TMP = $temp
$components = @('Microsoft.VisualStudio.Component.Windows11SDK.26100','Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64','Microsoft.VisualStudio.Component.VC.14.44.17.14.ARM64','Microsoft.VisualStudio.Component.VC.14.44.17.14.ATL','Microsoft.VisualStudio.Component.VC.14.44.17.14.ATL.ARM64')
$channel = 'https://download.visualstudio.microsoft.com/download/pr/bc92e2cb-33de-4a0c-995d-efa817f16b16/0dbdfd40c17757e64fc9f72cd9954ec8471c04fd8461a77806e5291e23239ac0/VisualStudio.17.Release.chman'
$arguments = @('--layout', $layout, '--lang', 'en-US', '--quiet', '--wait', '--channelUri', $channel)
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
try {
  $process = Start-Process -FilePath $bootstrapper -ArgumentList $arguments -PassThru -WindowStyle Hidden
  while (!$process.WaitForExit(2000)) {
    $files = @(Get-ChildItem -LiteralPath $mount -File -Recurse -Force -ErrorAction Stop)
    $bytes = [long]($files | Measure-Object Length -Sum).Sum
    $externalGrowth = [Math]::Max(0, (Get-CacheBytes) - $initialCacheBytes)
    if (($bytes + $externalGrowth) -gt 4GB -or $files.Count -gt 1000 -or ([DateTime]::UtcNow - $started).TotalMinutes -gt 45) { throw 'Layout acquisition budget exceeded' }
  }
  $process.Refresh()
  if ($process.ExitCode -ne 0) { throw "Layout acquisition failed: $($process.ExitCode)" }
  $files = @(Get-ChildItem -LiteralPath $mount -File -Recurse -Force)
  if ($files.Count -gt 1000 -or (([long]($files | Measure-Object Length -Sum).Sum) + [Math]::Max(0, (Get-CacheBytes)-$initialCacheBytes)) -gt 4GB) { throw 'Final layout budget exceeded' }
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
  Get-ChildItem -LiteralPath $temp -Filter 'dd_*' -File -ErrorAction SilentlyContinue | Copy-Item -Destination $ReceiptRoot
  "layout_path=$layout" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
}
