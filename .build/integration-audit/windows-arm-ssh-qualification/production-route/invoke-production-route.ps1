param(
 [Parameter(Mandatory=$true)][string]$SourceRoot,
 [Parameter(Mandatory=$true)][string]$SourceCommit,
 [Parameter(Mandatory=$true)][string]$Username,
 [Parameter(Mandatory=$true)][int]$Port,
 [Parameter(Mandatory=$true)][string]$IdentityFile,
 [Parameter(Mandatory=$true)][string]$KnownHosts,
 [Parameter(Mandatory=$true)][string]$ReceiptRoot
)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:ORCA_ISOLATED_SSH_CI -ne '1'){throw 'Disposable CI only'}
if($SourceCommit -notmatch '^[a-f0-9]{40}$'){throw 'Exact source hash required'}
Push-Location $SourceRoot
$knownPath=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ssh\known_hosts'
$priorKnown=$null
$knownExisted=Test-Path -LiteralPath $knownPath
if($knownExisted){$priorKnown=[IO.File]::ReadAllBytes($knownPath)}
try {
 $observed=(& git rev-parse HEAD).Trim()
 if($LASTEXITCODE -ne 0 -or $observed -ne $SourceCommit){throw 'Source checkout mismatch'}
 if(!(Test-Path 'out\relay\win32-arm64\relay.js')){throw 'Build real relay artifacts before server provisioning'}
 New-Item -ItemType Directory -Path $ReceiptRoot -Force | Out-Null
 New-Item -ItemType Directory -Path (Split-Path $knownPath) -Force | Out-Null
 $pinned=[IO.File]::ReadAllText($KnownHosts)
 if($pinned -notmatch [regex]::Escape("[127.0.0.1]:$Port")){throw 'Missing private endpoint host-key pin'}
 Add-Content -LiteralPath $knownPath -Value "`n$pinned"
 $env:ORCA_SSH_PROBE_STATE=Join-Path $ReceiptRoot 'state'
 New-Item -ItemType Directory -Path $env:ORCA_SSH_PROBE_STATE -Force | Out-Null
 $env:ORCA_RELAY_PATH=Join-Path $SourceRoot 'out\relay'
 $env:ORCA_SSH_PROBE_CONFIG=Join-Path $ReceiptRoot 'config.json'
 @{sourceCommit=$SourceCommit;observedSourceCommit=$observed;username=$Username;port=$Port;identityFile=$IdentityFile;receiptPath=(Join-Path $ReceiptRoot 'production-route.json')} | ConvertTo-Json | Set-Content $env:ORCA_SSH_PROBE_CONFIG
 Copy-Item -LiteralPath "$PSScriptRoot\windows-arm-production-route.test.ts" -Destination 'src\main\ssh\windows-arm-production-route.test.ts'
 & node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/ssh/windows-arm-production-route.test.ts --no-file-parallelism --reporter=verbose
 if($LASTEXITCODE -ne 0){throw 'Production SSH route qualification failed'}
 $result=Get-Content (Join-Path $ReceiptRoot 'production-route.json') -Raw | ConvertFrom-Json
 if(!$result.sameShellState -or !$result.cleanupVerified){throw 'Production route cleanup/evidence incomplete'}
} finally {
 if($knownExisted){[IO.File]::WriteAllBytes($knownPath,$priorKnown)}else{Remove-Item -LiteralPath $knownPath -Force -ErrorAction SilentlyContinue}
 Remove-Item Env:ORCA_SSH_PROBE_CONFIG,Env:ORCA_SSH_PROBE_STATE,Env:ORCA_RELAY_PATH -ErrorAction SilentlyContinue
 Pop-Location
}
