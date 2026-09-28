param([Parameter(Mandatory=$true)][string]$Inputs,[Parameter(Mandatory=$true)][string]$Receipt)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true'){throw 'Disposable CI only'}
$planPath=Join-Path $PSScriptRoot 'media-input-plan.json'
if((Get-FileHash -LiteralPath $planPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne '6e3cfa60f677cb3b0556f10d3a1036292605fe4e64e585e966b0a2438a43ba8e'){throw 'Media plan hash mismatch'}
$plan=Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
if($plan.primaryInputs.Count -ne 1){throw 'Unexpected selected MSI count'}
$installer=New-Object -ComObject WindowsInstaller.Installer
$mapped=@();$databases=@();$mediaRows=@()
try {
  foreach($item in $plan.primaryInputs){
    $path=Join-Path $Inputs ([IO.Path]::GetFileName($item.cachePath))
    if((Get-Item -LiteralPath $path).Length -ne $item.retainedBytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256){throw 'MSI input identity mismatch'}
    $database=$null;$view=$null
    try {
      # Mode zero opens the database read-only; no install session or custom action runs.
      $database=$installer.OpenDatabase($path,0)
      $view=$database.OpenView('SELECT `LastSequence`, `Cabinet` FROM `Media`')
      $view.Execute()
      $rows=0;$cabinets=0
      while($record=$view.Fetch()){
        try {
          $rows++
          if($rows -gt 300){throw 'Media table row budget exceeded'}
          $cabinet=$record.StringData(2).Trim('"')
          $mediaRows+=@{msiSha256=$item.sha256;lastSequence=$record.IntegerData(1);cabinet=$cabinet}
          if(-not $cabinet){continue}
          if($cabinet.StartsWith('#') -or [IO.Path]::GetFileName($cabinet) -ne $cabinet -or $cabinet.Contains(':') -or $cabinet.Contains('/')){throw 'Unsupported or unsafe cabinet name'}
          $matches=@($plan.cabCandidates | Where-Object {$_.package -eq $item.package -and ([IO.Path]::GetFileName($_.fileName.Replace('\','/'))) -ceq $cabinet})
          if($matches.Count -ne 1){throw 'Missing or ambiguous Media cabinet identity'}
          $cab=$matches[0]
          $mapped+=@{msiSha256=$item.sha256;lastSequence=$record.IntegerData(1);cachePath=('dl/'+[IO.Path]::GetFileNameWithoutExtension($item.cachePath)+'/'+$cabinet);layoutPath=$cab.layoutPath;sha256=$cab.sha256;bytes=$cab.retainedBytes}
          $cabinets++
        } finally {[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record)}
      }
      $databases+=@{cachePath=$item.cachePath;sha256=$item.sha256;mediaRows=$rows;cabinets=$cabinets}
    } finally {
      if($view){$view.Close();[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)}
      if($database){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)}
    }
    if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256){throw 'Read-only MSI changed'}
    @{complete=$false;readOnly=$true;databases=$databases;mediaRows=$mediaRows;cabinetAliases=$mapped} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Receipt
  }
  if(-not $mapped.Count){throw 'Historical UCRT MSI has no external cabinets'}
  $unique=@($mapped | Sort-Object sha256 -Unique)
  $bytes=($unique | Measure-Object bytes -Sum).Sum
  if($unique.Count -gt 300 -or $mapped.Count -gt 300 -or $bytes -gt 1GB){throw 'Selected cabinet cache budget exceeded'}
  @{complete=$true;readOnly=$true;productInstalled=$false;catalogSha256=$plan.catalogSha256;databases=$databases;mediaRows=$mediaRows;cabinetAliases=$mapped;uniqueCabinetBytes=$bytes;historicalUcrtMissing=$false} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Receipt
} finally {[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)}
