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
# Extract functions through the AST: never provision the fixture while testing diagnostics.
'PASS: fixture parse and five numeric-diagnostic cases'
