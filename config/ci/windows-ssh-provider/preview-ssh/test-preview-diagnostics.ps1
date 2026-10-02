$ErrorActionPreference='Stop'
$errors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'prove-preview-openssh.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Fixture failed to parse'}
# Script-scope assignments share one case-insensitive namespace with typed params: $accounts rebinds [int]$Accounts.
foreach($script in @($ast,[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../invoke-pinned-relay-cells.ps1'),[ref]$null,[ref]$null))){
  $params=@($script.ParamBlock.Parameters | ForEach-Object {$_.Name.VariablePath.UserPath})
  $shadows=@($script.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left -is [Management.Automation.Language.VariableExpressionAst]},$true) | Where-Object {
    $parent=$_.Parent;while($parent -and $parent -isnot [Management.Automation.Language.FunctionDefinitionAst] -and $parent -isnot [Management.Automation.Language.ScriptBlockExpressionAst]){$parent=$parent.Parent}
    -not $parent -and $_.Left.VariablePath.UserPath -in $params
  } | ForEach-Object {$_.Left.VariablePath.UserPath})
  if($shadows.Count){throw "Script-scope assignment rebinds a typed param: $($shadows -join ', ')"}
}
$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Diagnostic-ExitStatuses'},$true)
. ([scriptblock]::Create($definition.Extent.Text))
function Assert-Statuses([string]$Text,[long[]]$Expected){
  $actual=@(Diagnostic-ExitStatuses $Text)
  if(($actual -join ',') -ne ($Expected -join ',')){throw 'Unexpected numeric diagnostic'}
}
Assert-Statuses "debug1: Exit status 3221225781`nclient secret path /private/id" @(3221225781)
Assert-Statuses 'CreateProcess error: 5; exit code -1073741515' @(5,-1073741515)
Assert-Statuses 'identity key-123, host 127.0.0.1 port 65000' @()
Assert-Statuses ('x'*16384+' exit status 123') @()
Assert-Statuses (('exit status 7; '*20)) @(7,7,7,7,7,7,7,7)
$split=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Split-HostToolchainPath'},$true)
. ([scriptblock]::Create($split.Extent.Text))
$pathRoot=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
try {
  $nodeDir=Join-Path $pathRoot 'nodejs';$gccDir=Join-Path $pathRoot 'mingw';$plainDir=Join-Path $pathRoot 'tools'
  New-Item -ItemType Directory -Path $nodeDir,$gccDir,$plainDir | Out-Null
  New-Item -ItemType File -Path (Join-Path $nodeDir 'node.exe'),(Join-Path $nodeDir 'npm.cmd'),(Join-Path $gccDir 'gcc.exe'),(Join-Path $plainDir 'git.exe') | Out-Null
  $result=Split-HostToolchainPath "$nodeDir;;$plainDir;$gccDir;$(Join-Path $pathRoot 'missing');Q:\no-such-drive" @('npm','gcc','node')
  if(($result.hidden -join '|') -ne "$nodeDir|$gccDir"){throw 'Toolchain PATH entries not hidden'}
  if(($result.kept -join '|') -ne "$plainDir|$(Join-Path $pathRoot 'missing')|Q:\no-such-drive"){throw 'Plain PATH entries not kept in order'}
} finally {Remove-Item -LiteralPath $pathRoot -Recurse -Force -ErrorAction SilentlyContinue}
# Mock only the machine boundary; exercise the shared installer without servicing this host.
. (Join-Path $PSScriptRoot 'windows-ssh-capability.ps1')
function Assert-IsolatedWindowsSshCi([string]$Arch){if($script:refuseCapabilityHost){throw 'Injected host refusal'}}
function Assert-WindowsSshGlobalServerDormant([string]$Server){$script:globalChecks++;if($script:globalChecks -eq $script:refuseGlobalCheck){throw 'Injected global server refusal'}}
function Assert-WindowsSshStockShell {$script:shellChecks++;if($script:shellChecks -eq $script:refuseShellCheck){throw 'Injected shell refusal'}}
function Get-WindowsCapability([switch]$Online,[string]$Name){$script:capabilityQueries++;return @{State=$script:capabilityState}}
function Add-WindowsCapability([switch]$Online,[string]$Name){$script:capabilityAdds++;if($script:failCapabilityInstall){throw 'Injected capability install failure'}}
function Reset-CapabilityControl([string]$State){
  $script:capabilityState=$State;$script:capabilityQueries=0;$script:capabilityAdds=0
  $script:globalChecks=0;$script:shellChecks=0;$script:refuseGlobalCheck=0;$script:refuseShellCheck=0
  $script:refuseCapabilityHost=$false;$script:failCapabilityInstall=$false
  $script:capabilityStages=[Collections.Generic.List[string]]::new()
}
foreach($state in @('Installed','NotPresent')){
  Reset-CapabilityControl $state
  $capabilityReport=@{}
  Install-WindowsInboxSshCapability 'x64' $capabilityReport {param($name) $script:capabilityStages.Add($name)}
  $expectedAdds=if($state -eq 'Installed'){0}else{1}
  if($capabilityReport.inboxCapabilityInitialState -ne $state -or $script:capabilityAdds -ne $expectedAdds -or $script:globalChecks -ne 2 -or $script:shellChecks -ne 2 -or ($script:capabilityStages -join ',') -ne 'inbox-capability-start,inbox-capability-complete'){throw 'Shared capability preparation did not preserve the install and guard boundaries'}
}
foreach($fault in @('host','global-before','shell-before','global-after','shell-after','install')){
  Reset-CapabilityControl 'NotPresent'
  switch($fault){
    'host' {$script:refuseCapabilityHost=$true}
    'global-before' {$script:refuseGlobalCheck=1}
    'shell-before' {$script:refuseShellCheck=1}
    'global-after' {$script:refuseGlobalCheck=2}
    'shell-after' {$script:refuseShellCheck=2}
    'install' {$script:failCapabilityInstall=$true}
  }
  $rejected=$false
  try {Install-WindowsInboxSshCapability 'x64' @{} {param($name) $script:capabilityStages.Add($name)}} catch {$rejected=$true}
  if(-not $rejected -or $script:capabilityStages.Contains('inbox-capability-complete')){throw "Capability fault did not fail closed: $fault"}
  if($fault -in @('host','global-before','shell-before') -and $script:capabilityAdds){throw 'Capability mutation preceded its host guards'}
}
$capabilityRoot=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $capabilityRoot | Out-Null
  $capabilityReceipt=Join-Path $capabilityRoot 'capability.json'
  Reset-CapabilityControl 'Installed'
  Initialize-WindowsInboxSshCapability 'x64' $capabilityReceipt
  $completed=Get-Content -LiteralPath $capabilityReceipt -Raw | ConvertFrom-Json
  if($completed.status -ne 'passed' -or $completed.inboxCapabilityInitialState -ne 'Installed'){throw 'Capability success receipt missing its observed initial state'}
  Reset-CapabilityControl 'NotPresent';$script:failCapabilityInstall=$true
  $rejected=$false
  try {Initialize-WindowsInboxSshCapability 'x64' $capabilityReceipt} catch {$rejected=$true}
  $failed=Get-Content -LiteralPath $capabilityReceipt -Raw | ConvertFrom-Json
  if(-not $rejected -or $failed.status -ne 'failed' -or $failed.inboxCapabilityInitialState -ne 'NotPresent' -or $failed.error -ne 'Injected capability install failure'){throw 'Failed capability preparation masqueraded as a passing receipt'}
} finally {Remove-Item -LiteralPath $capabilityRoot -Recurse -Force -ErrorAction SilentlyContinue}
# Extract functions through the AST: never provision the fixture while testing diagnostics.
'PASS: fixture parse, diagnostics, PATH split, capability boundaries and failure receipts'
