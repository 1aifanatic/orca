$ErrorActionPreference = 'Stop'
$root = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer'
$out = Join-Path $env:RUNNER_TEMP 'vs-verifier-inspection'
New-Item -ItemType Directory -Force -Path $out | Out-Null
if (!(Test-Path -LiteralPath $root)) { throw 'Existing Visual Studio Installer not found' }
$files = @(Get-ChildItem -LiteralPath $root -File | Where-Object { $_.Extension -in '.exe', '.dll' })
if ($files.Count -gt 150 -or ($files | Measure-Object Length -Sum).Sum -gt 512MB) { throw 'Installer inspection budget exceeded' }
$records = foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  [ordered]@{
    name = $file.Name
    bytes = $file.Length
    sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    fileVersion = $file.VersionInfo.FileVersion
    productVersion = $file.VersionInfo.ProductVersion
    signatureStatus = [string]$signature.Status
    signatureType = [string]$signature.SignatureType
    signerSubject = $signature.SignerCertificate.Subject
    signerThumbprint = $signature.SignerCertificate.Thumbprint
    timestampSubject = $signature.TimeStamperCertificate.Subject
    timestampThumbprint = $signature.TimeStamperCertificate.Thumbprint
  }
}
$records | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $out 'installer-identities.json') -Encoding utf8
[ordered]@{imageOS=$env:ImageOS;imageVersion=$env:ImageVersion;os=[Environment]::OSVersion.VersionString;executedInstaller=$false;downloadedPayloads=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'scope.json') -Encoding utf8
# Read assembly identities without loading or executing installer code.
$inspection = foreach ($file in $files | Where-Object { $_.Name -match 'Security|Manifest|Catalog|Engine|Setup' }) {
  try {
    $assembly = [System.Reflection.AssemblyName]::GetAssemblyName($file.FullName)
    [ordered]@{name=$file.Name;assemblyIdentity=$assembly.FullName}
  } catch [System.BadImageFormatException] {
    [ordered]@{name=$file.Name;assemblyIdentity='native executable'}
  }
}
$inspection | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $out 'assembly-identities.json') -Encoding utf8
$valid = @($records | Where-Object { $_.name -eq 'setup.exe' -and $_.signatureStatus -eq 'Valid' -and $_.signerSubject -match 'O=Microsoft Corporation(?:,|$)' })
if ($valid.Count -ne 1) { throw 'No uniquely identified valid Microsoft-signed setup.exe' }
