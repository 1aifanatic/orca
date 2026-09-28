param([Parameter(Mandatory=$true)][string]$Layout,[Parameter(Mandatory=$true)][string]$Bootstrapper,[Parameter(Mandatory=$true)][string]$Receipts)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Disposable CI only' }
New-Item -ItemType Directory -Path $Receipts | Out-Null
& "$PSScriptRoot\inspect-bootstrapper.ps1" -Bootstrapper $Bootstrapper -Receipt (Join-Path $Receipts 'bootstrapper-identity.json')
$catalog = Join-Path $Layout 'Catalog.json'
$originalCatalog = [IO.File]::ReadAllBytes($catalog)
if ((Get-FileHash -LiteralPath $catalog -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'f0a50ea157222c29abd5ea6ff01bfc3c33b04e011c5e45ee2ca38ef0778e5643') { throw 'Unexpected catalog' }
$payload = Get-ChildItem -LiteralPath $Layout -File -Recurse | Where-Object { $_.Extension -eq '.vsix' } | Sort-Object FullName | Select-Object -First 1
if (!$payload) { throw 'No retained VSIX payload for negative control' }
$payloadHash = (Get-FileHash -LiteralPath $payload.FullName -Algorithm SHA256).Hash
$adapters = @(Get-NetAdapter -IncludeHidden | Where-Object { $_.Status -eq 'Up' })
if ($adapters.Count -eq 0) { throw 'No adapters to isolate; inspect runner networking' }
$adapters | Select-Object Name,InterfaceDescription,InterfaceGuid,Status | ConvertTo-Json | Set-Content (Join-Path $Receipts 'network-before.json')
$results = @()
function Run-Verify([string]$Case) {
  if (@(Get-NetAdapter -IncludeHidden | Where-Object { $_.Status -eq 'Up' }).Count -ne 0) { throw 'Network adapter became active during offline verification' }
  $caseRoot = Join-Path $Receipts $Case
  New-Item -ItemType Directory -Path $caseRoot | Out-Null
  $env:TEMP = $caseRoot
  $env:TMP = $caseRoot
  $process = Start-Process -FilePath $Bootstrapper -ArgumentList @('--layout', ('"'+$Layout+'"'), '--verify', '--quiet', '--wait') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $caseRoot 'stdout.txt') -RedirectStandardError (Join-Path $caseRoot 'stderr.txt')
  try {
    if (!$process.WaitForExit(600000)) { throw "Offline verify timed out: $Case" }
    $process.Refresh()
    if (@(Get-NetAdapter -IncludeHidden | Where-Object { $_.Status -eq 'Up' }).Count -ne 0) { throw 'Offline verification lost network isolation' }
    $caseResult=[ordered]@{case=$Case;exitCode=$process.ExitCode;networkAdaptersDown=$true}
    $caseResult | ConvertTo-Json | Set-Content (Join-Path $caseRoot 'result.json')
    return $caseResult
  } catch {
    @{case=$Case;error=$_.Exception.Message;completed=$false} | ConvertTo-Json | Set-Content (Join-Path $caseRoot 'failure.json')
    throw
  } finally {
    if (!$process.HasExited) {
      & "$env:WINDIR\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
      $killCode=$LASTEXITCODE
      $exited=$process.WaitForExit(10000)
      @{taskkillExitCode=$killCode;rootExited=$exited;descendantExitVerified=$false} | ConvertTo-Json | Set-Content (Join-Path $caseRoot 'termination.json')
      if ($killCode -ne 0 -or !$exited) { Write-Warning 'Verifier termination unconfirmed; restore CI networking without claiming offline success' }
    }
  }
}
try {
  foreach ($adapter in $adapters) { Disable-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction Stop }
  if (@(Get-NetAdapter -IncludeHidden | Where-Object { $_.Status -eq 'Up' }).Count -ne 0) { throw 'Could not isolate network adapters' }
  $result = Run-Verify 'original'
  $results += $result
  if ($result.exitCode -ne 0) { throw 'Original offline layout failed verification; negative controls not meaningful' }
  # Change one signed payload hash character without altering valid JSON or signature bytes.
  $text = [Text.Encoding]::UTF8.GetString($originalCatalog)
  $match = [regex]::Match($text, '"sha256"\s*:\s*"([0-9a-fA-F]{64})"')
  if (!$match.Success) { throw 'No catalog payload hash for mutation' }
  $index = $match.Groups[1].Index
  $byteOffset = [Text.Encoding]::UTF8.GetByteCount($text.Substring(0,$index))
  $mutant = [byte[]]$originalCatalog.Clone()
  $mutant[$byteOffset] = if ($mutant[$byteOffset] -eq 48) { 49 } else { 48 }
  [IO.File]::WriteAllBytes($catalog,$mutant)
  @{offset=$byteOffset;before=$originalCatalog[$byteOffset];after=$mutant[$byteOffset];sha256=(Get-FileHash $catalog -Algorithm SHA256).Hash} | ConvertTo-Json | Set-Content (Join-Path $Receipts 'catalog-mutation.json')
  try { $result = Run-Verify 'catalog-mutated'; $results += $result } finally { [IO.File]::WriteAllBytes($catalog,$originalCatalog) }
  if ($result.exitCode -eq 0) { throw 'Catalog mutation was accepted; signature verification not established' }
  $stream = [IO.File]::Open($payload.FullName,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try { $first = $stream.ReadByte(); $stream.Position=0; $stream.WriteByte($first -bxor 1) } finally { $stream.Dispose() }
  try { $result=Run-Verify 'payload-mutated'; $results += $result } finally {
    $stream=[IO.File]::OpenWrite($payload.FullName)
    try { $stream.WriteByte($first) } finally { $stream.Dispose() }
  }
  if ($result.exitCode -eq 0) { throw 'Corrupt payload accepted by verifier' }
  if ((Get-FileHash -LiteralPath $catalog -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'f0a50ea157222c29abd5ea6ff01bfc3c33b04e011c5e45ee2ca38ef0778e5643') { throw 'Catalog restoration mismatch' }
  if ((Get-FileHash -LiteralPath $payload.FullName -Algorithm SHA256).Hash -ne $payloadHash) { throw 'Payload restoration mismatch' }
} finally {
  try {
    [IO.File]::WriteAllBytes($catalog,$originalCatalog)
    $results | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Receipts 'verification-results.json')
    @{manifestSignatureVerified=$false;reason='Classify original and tampered logs before making a cryptographic claim';productInstalled=$false} | ConvertTo-Json | Set-Content (Join-Path $Receipts 'trust-claims.json')
  } finally {
    foreach ($adapter in $adapters) { Enable-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction Continue }
    $restoreDeadline=[DateTime]::UtcNow.AddSeconds(30)
    do {
      $current=@(Get-NetAdapter -IncludeHidden)
      $restored=@($adapters | ForEach-Object {
        $expected=$_
        $match=@($current | Where-Object {$_.InterfaceGuid -eq $expected.InterfaceGuid -and $_.Status -eq 'Up'})
        @{interfaceGuid=$expected.InterfaceGuid;restored=($match.Count -eq 1)}
      })
      if (-not @($restored | Where-Object {-not $_.restored}).Count) { break }
      Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $restoreDeadline)
    $restored | ConvertTo-Json | Set-Content (Join-Path $Receipts 'network-restored.json')
    if (@($restored | Where-Object {-not $_.restored}).Count) { throw 'Network restoration unverified; discard disposable CI runner' }
  }
}
