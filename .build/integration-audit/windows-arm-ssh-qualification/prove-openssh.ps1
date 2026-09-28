# Ephemeral CI only. Phase 1 proves the real native server/account/cmd.exe/auth boundary.
param([Parameter(Mandatory=$true)][string]$Receipt)
$ErrorActionPreference = 'Stop'
$report = @{scope='native Windows OpenSSH loopback key authentication and stock cmd.exe dispatch; not relay deployment'; status='running'; imageVersion=$env:ImageVersion; cleanup=@('not-confirmed'); observations=@(); stages=@()}
$script:receiptWritten=$false
function Write-Stage([string]$Stage) {
  $timestamp=[DateTime]::UtcNow.ToString('o')
  $report.stages += @{stage=$Stage; utc=$timestamp}
  try {
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 6))
    $temporary="$Receipt.pending"
    $stream=[IO.FileStream]::new($temporary,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
    [IO.File]::Move($temporary,$Receipt,$true)
    $script:receiptWritten=$true
  } catch {Write-Warning 'Progress receipt could not be updated; cleanup must still run'}
  Write-Host "Native SSH stage: $Stage ($timestamp)"
}
Write-Stage 'preflight-start'
if(-not $script:receiptWritten){throw 'Initial progress receipt unavailable; refuse provisioning'}
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:ORCA_ISOLATED_SSH_CI -ne '1' -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ne 'Arm64') { throw 'Requires isolated native ARM64 GitHub runner' }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Administrative capability servicing required' }
$capability = 'OpenSSH.Server~~~~0.0.1.0'
Write-Stage 'capability-and-service-query-start'
if ((Get-WindowsCapability -Online -Name $capability).State -ne 'NotPresent' -or (Get-Service sshd -ErrorAction SilentlyContinue)) { throw 'Refuse a machine with an existing SSH server' }
Write-Stage 'capability-and-service-query-complete'
Write-Stage 'firewall-query-start'
if (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue) { throw 'Refuse pre-existing OpenSSH firewall rule' }
Write-Stage 'firewall-query-complete'
Write-Stage 'default-shell-query-start'
$registry = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\OpenSSH' -ErrorAction SilentlyContinue
if ($registry.DefaultShell -or $registry.DefaultShellCommandOption) { throw 'Requires stock cmd.exe OpenSSH shell; never rewrite registry' }
Write-Stage 'default-shell-query-complete'
$id = [Guid]::NewGuid().ToString('N').Substring(0,10)
$name = "orca$id"
$serviceName = "orca-sshd-$id"
$root = Join-Path $env:RUNNER_TEMP "ossh-$id"
Write-Stage 'private-directory-create-start'
New-Item -ItemType Directory -Path $root | Out-Null
Write-Stage 'private-directory-create-complete'
$report.root=$root
$installed=$false; $createdUser=$false; $createdService=$false; $sid=$null; $ownedServerPid=$null
$sshDir=Join-Path $env:WINDIR 'System32\OpenSSH'
function Invoke-Bounded([string]$Program,[string[]]$Arguments,[int]$Seconds=20,[switch]$AllowFailure) {
  Write-Stage ('command-'+[IO.Path]::GetFileName($Program)+'-start')
  $start=[Diagnostics.ProcessStartInfo]::new($Program)
  $start.UseShellExecute=$false; $start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
  foreach($argument in $Arguments){$start.ArgumentList.Add($argument)}
  $process=[Diagnostics.Process]::new();$process.StartInfo=$start
  try {
    if(-not $process.Start()){throw 'Owned command failed to start'}
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit($Seconds*1000)){$process.Kill($true);$process.WaitForExit();throw 'Owned command deadline exceeded'}
    $output=$stdout.GetAwaiter().GetResult();$errorText=$stderr.GetAwaiter().GetResult()
    if($output.Length+$errorText.Length -gt 1048576){throw 'Owned command output limit exceeded'}
    if($process.ExitCode -ne 0 -and -not $AllowFailure){throw "Owned command failed: $([IO.Path]::GetFileName($Program)) exit $($process.ExitCode)"}
    Write-Stage ('command-'+[IO.Path]::GetFileName($Program)+'-complete')
    return @{code=$process.ExitCode; stdout=$output}
  } finally {$process.Dispose()}
}
function Machine([string]$Path){
  $file=[IO.File]::OpenRead($Path)
  try{$reader=[IO.BinaryReader]::new($file);$file.Position=0x3c;$position=$reader.ReadInt32();$file.Position=$position;if($reader.ReadUInt32()-ne 0x00004550){throw 'Invalid PE'};return ('0x{0:X4}'-f $reader.ReadUInt16())}finally{$file.Dispose()}
}
try {
  $installed=$true
  Write-Stage 'capability-install-start'
  $result=Add-WindowsCapability -Online -Name $capability
  Write-Stage 'capability-install-complete'
  if($result.RestartNeeded){throw 'OS server capability requires reboot; qualification refused'}
  Write-Stage 'global-service-check-start'
  if((Get-Service sshd).Status -ne 'Stopped'){Stop-Service sshd -Force;throw 'Capability unexpectedly started global sshd'}
  Write-Stage 'global-service-check-complete'
  Write-Stage 'added-firewall-disable-start'
  $rule=Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
  if($rule){$rule | Disable-NetFirewallRule | Out-Null}
  Write-Stage 'added-firewall-disable-complete'
  $sshd=Join-Path $sshDir 'sshd.exe';$ssh=Join-Path $sshDir 'ssh.exe';$keygen=Join-Path $sshDir 'ssh-keygen.exe'
  if((Machine $sshd)-ne '0xAA64' -or (Machine $ssh)-ne '0xAA64'){throw 'SSH server/client must both be native ARM64'}
  Write-Stage 'publisher-check-start'
  $signature=Get-AuthenticodeSignature -FilePath $sshd
  Write-Stage 'publisher-check-complete'
  if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft'){throw 'OS sshd publisher signature not verified'}
  $password=ConvertTo-SecureString ([Guid]::NewGuid().ToString('N')+'aA!7') -AsPlainText -Force
  Write-Stage 'private-user-collision-query-start'
  if(Get-LocalUser -Name $name -ErrorAction SilentlyContinue){throw 'Private username collision'}
  Write-Stage 'private-user-collision-query-complete'
  $createdUser=$true
  Write-Stage 'private-user-create-start'
  $user=New-LocalUser -Name $name -Password $password -AccountNeverExpires -PasswordNeverExpires -Description 'Ephemeral Orca SSH qualification'
  Write-Stage 'private-user-create-complete'
  $sid=$user.SID.Value
  Write-Stage 'private-user-group-start'
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
  Write-Stage 'private-user-group-complete'
  # No administrator membership, real runner auth files or global DefaultShell modifications.
  Invoke-Bounded icacls.exe @($root,'/inheritance:r','/grant:r','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F',"*$($sid):(RX)") | Out-Null
  $hostKey=Join-Path $root 'host_key';$clientKey=Join-Path $root 'client_key'
  Write-Stage 'private-key-create-start'
  Invoke-Bounded $keygen @('-q','-t','ed25519','-N','','-f',$hostKey) | Out-Null
  Invoke-Bounded $keygen @('-q','-t','ed25519','-N','','-f',$clientKey) | Out-Null
  Write-Stage 'private-key-create-complete'
  $authorized=Join-Path $root 'authorized_keys'
  Copy-Item -LiteralPath "$clientKey.pub" -Destination $authorized
  Invoke-Bounded icacls.exe @($authorized,'/inheritance:r','/grant:r','*S-1-5-18:F','*S-1-5-32-544:F',"*$($sid):R") | Out-Null
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
  $config=Join-Path $root 'sshd_config'
  $hostPosix=$hostKey.Replace('\','/');$authPosix=$authorized.Replace('\','/');$pidPosix=(Join-Path $root 'sshd.pid').Replace('\','/')
  @"
Port $port
ListenAddress 127.0.0.1
HostKey "$hostPosix"
PidFile "$pidPosix"
AuthorizedKeysFile "$authPosix"
AllowUsers $name
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
StrictModes yes
AllowTcpForwarding no
AllowAgentForwarding no
PermitTunnel no
PermitTTY no
LogLevel ERROR
"@ | Set-Content -LiteralPath $config -Encoding ascii
  Write-Stage 'server-config-validate-start'
  Invoke-Bounded $sshd @('-t','-f',$config) | Out-Null
  Write-Stage 'server-config-validate-complete'
  # A distinct LocalSystem service supplies Windows sshd's token-creation privileges.
  Write-Stage 'private-service-collision-query-start'
  if(Get-Service -Name $serviceName -ErrorAction SilentlyContinue){throw 'Private service name collision'}
  Write-Stage 'private-service-collision-query-complete'
  $createdService=$true
  Write-Stage 'private-service-create-start'
  New-Service -Name $serviceName -BinaryPathName "`"$sshd`" -f `"$config`"" -StartupType Manual | Out-Null
  Write-Stage 'private-service-create-complete'
  Invoke-Bounded sc.exe @('privs',$serviceName,'SeAssignPrimaryTokenPrivilege/SeTcbPrivilege/SeBackupPrivilege/SeRestorePrivilege/SeImpersonatePrivilege') | Out-Null
  Write-Stage 'private-service-start-start'
  Start-Service -Name $serviceName
  Write-Stage 'private-service-start-complete'
  Write-Stage 'private-service-identity-start'
  $service=Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
  Write-Stage 'private-service-identity-complete'
  if($service.StartName -ne 'LocalSystem' -or -not $service.ProcessId){throw 'Private service identity unavailable'}
  $ownedServerPid=$service.ProcessId
  $keyFields=(Get-Content -LiteralPath "$hostKey.pub" -Raw).Trim().Split(' ')
  $known=Join-Path $root 'known_hosts'
  "[127.0.0.1]:$port $($keyFields[0]) $($keyFields[1])" | Set-Content -LiteralPath $known -Encoding ascii
  $nonce=[Guid]::NewGuid().ToString('N')
  $sshArgs=@('-F','NUL','-T','-p',[string]$port,'-i',$clientKey,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o',"UserKnownHostsFile=$known",'-o','ConnectTimeout=5',"$name@127.0.0.1")
  $deadline=[DateTime]::UtcNow.AddSeconds(30);$probe=$null
  Write-Stage 'ssh-authentication-start'
  do {
    $probe=Invoke-Bounded $ssh ($sshArgs+@("echo $nonce && whoami && echo %COMSPEC%")) 8 -AllowFailure
    if($probe.code -eq 0){break};Start-Sleep -Milliseconds 250
  } while([DateTime]::UtcNow -lt $deadline)
  if($probe.code -ne 0 -or $probe.stdout -notmatch [regex]::Escape($nonce) -or $probe.stdout -notmatch "\\$name(?:\r?\n)" -or $probe.stdout -notmatch '(?i)cmd.exe'){throw 'Real SSH authentication/default-shell proof failed'}
  Write-Stage 'ssh-authentication-complete'
  Write-Stage 'listener-identity-start'
  $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $port)
  Write-Stage 'listener-identity-complete'
  if(-not $listeners -or @($listeners|Where-Object {$_.LocalAddress -ne '127.0.0.1' -or $_.OwningProcess -ne $ownedServerPid}).Count){throw 'Listener escaped private loopback owner'}
  $report.observations=@{serverMachine=(Machine $sshd);clientMachine=(Machine $ssh);publisherVerified=$true;serviceAccount='LocalSystem';dedicatedUser=$true;pinnedHostKey=$true;stockCmdDispatch=$true;loopbackOnly=$true;port=$port;servicePid=$ownedServerPid}
  $report.status='proof-passed-cleanup-pending'
} catch {
  $report.status='failed';$report.error=$_.Exception.Message
} finally {
  try {
    Write-Stage 'cleanup-start'
    Write-Stage 'cleanup-service-query-start'
    $privateService=Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    Write-Stage 'cleanup-service-query-complete'
    if($createdService -and $privateService -and ($privateService.PathName -notlike "*$root*" -or ($ownedServerPid -and $privateService.ProcessId -and $privateService.ProcessId -ne $ownedServerPid))){throw 'Private service identity changed; refuse stop'}
    Write-Stage 'cleanup-service-stop-delete-start'
    if($createdService){Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue;Invoke-Bounded sc.exe @('delete',$serviceName) | Out-Null}
    Write-Stage 'cleanup-service-stop-delete-complete'
    Write-Stage 'cleanup-process-exit-start'
    $exitDeadline=[DateTime]::UtcNow.AddSeconds(10)
    while($ownedServerPid -and (Get-Process -Id $ownedServerPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $exitDeadline){Start-Sleep -Milliseconds 100}
    if($ownedServerPid -and (Get-Process -Id $ownedServerPid -ErrorAction SilentlyContinue)){throw 'Private sshd process still live; no PID-only kill attempted'}
    Write-Stage 'cleanup-process-exit-complete'
    Write-Stage 'cleanup-service-absence-start'
    $serviceDeadline=[DateTime]::UtcNow.AddSeconds(10)
    while($createdService -and (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $serviceDeadline){Start-Sleep -Milliseconds 100}
    if($createdService -and (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)){throw 'Private service still registered'}
    Write-Stage 'cleanup-service-absence-complete'
    Write-Stage 'cleanup-user-profile-start'
    if($sid){Get-CimInstance Win32_UserProfile | Where-Object SID -eq $sid | Remove-CimInstance}
    Write-Stage 'cleanup-user-profile-complete'
    Write-Stage 'cleanup-user-start'
    if($createdUser){Remove-LocalUser -Name $name;if(Get-LocalUser -Name $name -ErrorAction SilentlyContinue){throw 'Private account still exists'}}
    Write-Stage 'cleanup-user-complete'
    Write-Stage 'cleanup-capability-remove-start'
    if($installed){Remove-WindowsCapability -Online -Name $capability | Out-Null}
    Write-Stage 'cleanup-capability-remove-complete'
    Write-Stage 'cleanup-firewall-start'
    $addedRule=Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
    if($addedRule){$addedRule | Remove-NetFirewallRule}
    Write-Stage 'cleanup-firewall-complete'
    Write-Stage 'cleanup-capability-confirm-start'
    if((Get-WindowsCapability -Online -Name $capability).State -ne 'NotPresent'){throw 'Added server capability removal not confirmed'}
    Write-Stage 'cleanup-capability-confirm-complete'
    Write-Stage 'cleanup-private-files-start'
    Remove-Item -LiteralPath $root -Recurse -Force
    Write-Stage 'cleanup-private-files-complete'
    if($report.status -eq 'proof-passed-cleanup-pending'){$report.status='passed'}
    $report.cleanup=@('private service stopped/deleted','owned sshd exit verified','private user/profile removed','added server capability removed','private keys removed')
  } catch {$report.status='failed';$report.cleanup=@('cleanup unverifiable; discard ephemeral runner');$report.cleanupError=$_.Exception.Message}
  Write-Stage 'finished'
}
if($report.status -ne 'passed'){throw 'Native OpenSSH qualification failed; inspect sanitized receipt'}
