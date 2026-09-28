param([Parameter(Mandatory=$true)][string]$Bootstrapper,[Parameter(Mandatory=$true)][string]$Receipt)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true'){throw 'Disposable CI only'}
$expected='37bb0fb429d163ecebd272a865d11a37b906d152bef960da2ddb29c2e2fd6eeb'
$file=Get-Item -LiteralPath $Bootstrapper
if($file.Length -ne 4473792){throw 'Bootstrapper size mismatch'}
$hash=(Get-FileHash -LiteralPath $Bootstrapper -Algorithm SHA256).Hash.ToLowerInvariant()
if($hash -ne $expected){throw 'Bootstrapper hash mismatch'}
$signature=Get-AuthenticodeSignature -LiteralPath $Bootstrapper
$version=$file.VersionInfo
$receiptData=[ordered]@{
  release='17.14.41'; documentedBuild='17.14.37710.0'; sha256=$hash; bytes=$file.Length
  fileVersion=$version.FileVersion; productVersion=$version.ProductVersion; productName=$version.ProductName
  signatureStatus=[string]$signature.Status; signerSubject=$signature.SignerCertificate.Subject
  signerThumbprint=$signature.SignerCertificate.Thumbprint
  timestampSubject=$signature.TimeStamperCertificate.Subject
  timestampThumbprint=$signature.TimeStamperCertificate.Thumbprint
  imageVersion=$env:ImageVersion; executedBootstrapper=$false; acquiredSdkPayloads=$false
}
$receiptData | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Receipt -Encoding utf8
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|, )O=Microsoft Corporation(?:,|$)'){
  throw 'Pinned bootstrapper Microsoft signature invalid'
}
