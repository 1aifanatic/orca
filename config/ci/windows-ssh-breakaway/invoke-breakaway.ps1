param(
  [Parameter(Mandatory=$true)][string]$Username,
  [Parameter(Mandatory=$true)][int]$Port,
  [Parameter(Mandatory=$true)][string]$IdentityFile,
  [Parameter(Mandatory=$true)][string]$KnownHosts,
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$Receipt
)
$ErrorActionPreference='Stop'
$nonce=[Guid]::NewGuid().ToString('N')
$ssh=(Get-Command ssh.exe -ErrorAction Stop).Source
$report=@{scope='standard-user explicit Windows job breakaway witness; NOT a relay/terminal migration qualification';status='running';cleanup='unverifiable';observations=@()}
$launchAttempted=$false
$primaryError=$null
function Save-Receipt { $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Receipt -Encoding utf8 }
function Invoke-Probe([string]$Mode,[switch]$AllowWaiting) {
  $start=[Diagnostics.ProcessStartInfo]::new($ssh)
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  foreach($argument in @('-F','NUL','-T','-p',[string]$Port,'-i',$IdentityFile,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o',"UserKnownHostsFile=$KnownHosts",'-o','ConnectTimeout=5',"$Username@127.0.0.1",('"'+$Executable+'" '+$Mode+' '+$nonce))){$start.ArgumentList.Add($argument)}
  $process=[Diagnostics.Process]::new();$process.StartInfo=$start
  try {
    if(-not $process.Start()){throw 'SSH client launch failed'}
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(10000)){
      $process.Kill($true)
      if(-not $process.WaitForExit(5000)){throw 'Owned SSH client stop unverified'}
      throw 'SSH probe deadline exceeded'
    }
    if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),5000)){throw 'SSH output deadline exceeded'}
    $text=$stdout.GetAwaiter().GetResult().Trim()
    $errorText=$stderr.GetAwaiter().GetResult()
    if($text.Length+$errorText.Length -gt 16384){throw 'Oversized SSH response'}
    if($AllowWaiting -and $process.ExitCode -eq 2 -and $text -eq 'waiting'){return 'waiting'}
    if($process.ExitCode -ne 0){
      $numeric=[regex]::Match($text,'^(launch-error|probe-error) (-?\d{1,10})$')
      $failure=@{phase=$Mode;sshExit=$process.ExitCode;nativeError=if($numeric.Success){[long]$numeric.Groups[2].Value}else{$null}}
      if(-not $report.ContainsKey('failure')){$report.failure=$failure}else{$report.cleanupFailure=$failure}
      throw 'SSH witness command failed'
    }
    return $text
  } finally {$process.Dispose()}
}
Save-Receipt
try {
  $report.phase='launch'
  $launchAttempted=$true
  $launch=Invoke-Probe '--launch'
  if($launch -notmatch '^launched (\d+) ([01])$'){throw 'Invalid launch witness'}
  $expectedPid=[int]$Matches[1]
  $report.parentInJob=[int]$Matches[2]
  if($report.parentInJob -ne 1){throw 'Launcher was not in an SSH job; no breakaway proven'}
  $report.phase='initial-witness'
  $readyDeadline=[DateTime]::UtcNow.AddSeconds(12)
  do {
    $first=Invoke-Probe '--read' -AllowWaiting
    if($first -ne 'waiting'){break}
    Start-Sleep -Milliseconds 200
  } while([DateTime]::UtcNow -lt $readyDeadline)
  if($first -notmatch '^(\d+) (\d+) (\d+) ([01])$'){throw 'Invalid initial witness'}
  $identity=@{pid=[int]$Matches[1];creationTicks=$Matches[2];tick=[int]$Matches[3];childInJob=[int]$Matches[4]}
  $report.observations+= $identity
  if($identity.pid -ne $expectedPid -or $identity.childInJob -ne 0){throw 'Witness PID differs or child stayed in job'}
  $report.phase='survival-witness'
  Start-Sleep -Milliseconds 500
  $second=Invoke-Probe '--read'
  if($second -notmatch '^(\d+) (\d+) (\d+) ([01])$'){throw 'Invalid survival witness'}
  $observation=@{pid=[int]$Matches[1];creationTicks=$Matches[2];tick=[int]$Matches[3];childInJob=[int]$Matches[4]}
  $report.observations+= $observation
  if($observation.pid -ne $identity.pid -or $observation.creationTicks -ne $identity.creationTicks -or $observation.tick -le $identity.tick -or $observation.childInJob -ne 0){throw 'Witness did not survive independent SSH transports'}
  $report.status='passed'
} catch {$primaryError=$_.Exception;$report.status='failed'}
finally {
  if($launchAttempted){
    try {
      Invoke-Probe '--stop' | Out-Null
      $deadline=[DateTime]::UtcNow.AddSeconds(50)
      do {
        $state=Invoke-Probe '--inspect'
        if($state -eq 'exited'){break}
        if($state -ne 'live'){throw 'Owned witness exit unverifiable'}
        Start-Sleep -Milliseconds 200
      } while([DateTime]::UtcNow -lt $deadline)
      if($state -ne 'exited'){throw 'Owned witness failed to exit'}
      if((Invoke-Probe '--cleanup') -ne 'exited'){throw 'Witness directory cleanup failed'}
      $report.cleanup='verified-exited-and-directory-removed'
    } catch {$report.cleanup='unverifiable';$report.status='failed';if(-not $primaryError){$primaryError=$_.Exception}}
  }
  Save-Receipt
}
if($primaryError){throw 'Breakaway qualification failed; inspect sanitized receipt'}
