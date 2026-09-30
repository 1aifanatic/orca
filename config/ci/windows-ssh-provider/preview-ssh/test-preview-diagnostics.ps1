$ErrorActionPreference='Stop'
$errors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'prove-preview-openssh.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Fixture failed to parse'}
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
  $result=Split-HostToolchainPath "$nodeDir;;$plainDir;$gccDir;$(Join-Path $pathRoot 'missing')" @('npm','gcc','node')
  if(($result.hidden -join '|') -ne "$nodeDir|$gccDir"){throw 'Toolchain PATH entries not hidden'}
  if(($result.kept -join '|') -ne "$plainDir|$(Join-Path $pathRoot 'missing')"){throw 'Plain PATH entries not kept in order'}
} finally {Remove-Item -LiteralPath $pathRoot -Recurse -Force -ErrorAction SilentlyContinue}
# Extract functions through the AST: never provision the fixture while testing diagnostics.
'PASS: fixture parse, five numeric-diagnostic cases and the toolchain PATH split'
