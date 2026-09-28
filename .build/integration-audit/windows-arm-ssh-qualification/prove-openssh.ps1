# Ephemeral CI only. Phase 1 proves the real native server/account/cmd.exe/auth boundary.
param([Parameter(Mandatory=$true)][string]$Receipt)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:ORCA_ISOLATED_SSH_CI -ne '1' -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ne 'Arm64') { throw 'Requires isolated native ARM64 GitHub runner' }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Administrative capability servicing required' }
$capability = 'OpenSSH.Server~~~~0.0.1.0'
if ((Get-WindowsCapability -Online -Name $capability).State -ne 'NotPresent' -or (Get-Service sshd -ErrorAction SilentlyContinue)) { throw 'Refuse a machine with an existing SSH server' }
if (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue) { throw 'Refuse pre-existing OpenSSH firewall rule' }
$registry = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\OpenSSH' -ErrorAction SilentlyContinue
if ($registry.DefaultShell -or $registry.DefaultShellCommandOption) { throw 'Requires stock cmd.exe OpenSSH shell; never rewrite registry' }
$id = [Guid]::NewGuid().ToString('N').Substring(0,10)
$name = "orca$id"
$serviceName = "orca-sshd-$id"
$root = Join-Path $env:RUNNER_TEMP "ossh-$id"
New-Item -ItemType Directory -Path $root | Out-Null
$report = @{scope='native Windows OpenSSH loopback key authentication and stock cmd.exe dispatch; not relay deployment'; status='running'; imageVersion=$env:ImageVersion; root=$root; cleanup=@(); observations=@()}
$installed=$false; $createdUser=$false; $createdService=$false; $sid=$null; $ownedServerPid=$null
$sshDir=Join-Path $env:WINDIR 'System32\OpenSSH'
function Invoke-Bounded([string]$Program,[string[]]$Arguments,[int]$Seconds=20,[switch]$AllowFailure) {
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
    return @{code=$process.ExitCode; stdout=$output}
  } finally {$process.Dispose()}
}
function Machine([string]$Path){
  $file=[IO.File]::OpenRead($Path)
  try{$reader=[IO.BinaryReader]::new($file);$file.Position=0x3c;$position=$reader.ReadInt32();$file.Position=$position;if($reader.ReadUInt32()-ne 0x00004550){throw 'Invalid PE'};return ('0x{0:X4}'-f $reader.ReadUInt16())}finally{$file.Dispose()}
}
try {
  $installed=$true
  $result=Add-WindowsCapability -Online -Name $capability
  if($result.RestartNeeded){throw 'OS server capability requires reboot; qualification refused'}
  if((Get-Service sshd).Status -ne 'Stopped'){Stop-Service sshd -Force;throw 'Capability unexpectedly started global sshd'}
  $rule=Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
  if($rule){$rule | Disable-NetFirewallRule | Out-Null}
  $sshd=Join-Path $sshDir 'sshd.exe';$ssh=Join-Path $sshDir 'ssh.exe';$keygen=Join-Path $sshDir 'ssh-keygen.exe'
  if((Machine $sshd)-ne '0xAA64' -or (Machine $ssh)-ne '0xAA64'){throw 'SSH server/client must both be native ARM64'}
  $signature=Get-AuthenticodeSignature -FilePath $sshd
  if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft'){throw 'OS sshd publisher signature not verified'}
  $password=ConvertTo-SecureString ([Guid]::NewGuid().ToString('N')+'aA!7') -AsPlainText -Force
  if(Get-LocalUser -Name $name -ErrorAction SilentlyContinue){throw 'Private username collision'}
  $createdUser=$true
  $user=New-LocalUser -Name $name -Password $password -AccountNeverExpires -PasswordNeverExpires -Description 'Ephemeral Orca SSH qualification'
  $sid=$user.SID.Value
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
  # No administrator membership, real runner auth files or global DefaultShell modifications.
  Invoke-Bounded icacls.exe @($root,'/inheritance:r','/grant:r','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F',"*$($sid):(RX)") | Out-Null
  $hostKey=Join-Path $root 'host_key';$clientKey=Join-Path $root 'client_key'
  Invoke-Bounded $keygen @('-q','-t','ed25519','-N','','-f',$hostKey) | Out-Null
  Invoke-Bounded $keygen @('-q','-t','ed25519','-N','','-f',$clientKey) | Out-Null
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
  Invoke-Bounded $sshd @('-t','-f',$config) | Out-Null
  # A distinct LocalSystem service supplies Windows sshd's token-creation privileges.
  if(Get-Service -Name $serviceName -ErrorAction SilentlyContinue){throw 'Private service name collision'}
  $createdService=$true
  New-Service -Name $serviceName -BinaryPathName "`"$sshd`" -f `"$config`"" -StartupType Manual | Out-Null
  Invoke-Bounded sc.exe @('privs',$serviceName,'SeAssignPrimaryTokenPrivilege/SeTcbPrivilege/SeBackupPrivilege/SeRestorePrivilege/SeImpersonatePrivilege') | Out-Null
  Start-Service -Name $serviceName
  $service=Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
  if($service.StartName -ne 'LocalSystem' -or -not $service.ProcessId){throw 'Private service identity unavailable'}
  $ownedServerPid=$service.ProcessId
  $keyFields=(Get-Content -LiteralPath "$hostKey.pub" -Raw).Trim().Split(' ')
  $known=Join-Path $root 'known_hosts'
  "[127.0.0.1]:$port $($keyFields[0]) $($keyFields[1])" | Set-Content -LiteralPath $known -Encoding ascii
  $nonce=[Guid]::NewGuid().ToString('N')
  $sshArgs=@('-F','NUL','-T','-p',[string]$port,'-i',$clientKey,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o',"UserKnownHostsFile=$known",'-o','ConnectTimeout=5',"$name@127.0.0.1")
  $deadline=[DateTime]::UtcNow.AddSeconds(30);$probe=$null
  do {
    $probe=Invoke-Bounded $ssh ($sshArgs+@("echo $nonce && whoami && echo %COMSPEC%")) 8 -AllowFailure
    if($probe.code -eq 0){break};Start-Sleep -Milliseconds 250
  } while([DateTime]::UtcNow -lt $deadline)
  if($probe.code -ne 0 -or $probe.stdout -notmatch [regex]::Escape($nonce) -or $probe.stdout -notmatch "\\$name(?:\r?\n)" -or $probe.stdout -notmatch '(?i)cmd.exe'){throw 'Real SSH authentication/default-shell proof failed'}
  $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $port)
  if(-not $listeners -or @($listeners|Where-Object {$_.LocalAddress -ne '127.0.0.1' -or $_.OwningProcess -ne $ownedServerPid}).Count){throw 'Listener escaped private loopback owner'}
  $report.observations=@{serverMachine=(Machine $sshd);clientMachine=(Machine $ssh);publisherVerified=$true;serviceAccount='LocalSystem';dedicatedUser=$true;pinnedHostKey=$true;stockCmdDispatch=$true;loopbackOnly=$true;port=$port;servicePid=$ownedServerPid}
  $report.status='passed'
} catch {
  $report.status='failed';$report.error=$_.Exception.Message
} finally {
  try {
    $privateService=Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    if($createdService -and $privateService -and ($privateService.PathName -notlike "*$root*" -or ($ownedServerPid -and $privateService.ProcessId -and $privateService.ProcessId -ne $ownedServerPid))){throw 'Private service identity changed; refuse stop'}
    if($createdService){Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue;Invoke-Bounded sc.exe @('delete',$serviceName) | Out-Null}
    $exitDeadline=[DateTime]::UtcNow.AddSeconds(10)
    while($ownedServerPid -and (Get-Process -Id $ownedServerPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $exitDeadline){Start-Sleep -Milliseconds 100}
    if($ownedServerPid -and (Get-Process -Id $ownedServerPid -ErrorAction SilentlyContinue)){throw 'Private sshd process still live; no PID-only kill attempted'}
    $serviceDeadline=[DateTime]::UtcNow.AddSeconds(10)
    while($createdService -and (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $serviceDeadline){Start-Sleep -Milliseconds 100}
    if($createdService -and (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)){throw 'Private service still registered'}
    if($sid){Get-CimInstance Win32_UserProfile | Where-Object SID -eq $sid | Remove-CimInstance}
    if($createdUser){Remove-LocalUser -Name $name;if(Get-LocalUser -Name $name -ErrorAction SilentlyContinue){throw 'Private account still exists'}}
    if($installed){Remove-WindowsCapability -Online -Name $capability | Out-Null}
    $addedRule=Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
    if($addedRule){$addedRule | Remove-NetFirewallRule}
    if((Get-WindowsCapability -Online -Name $capability).State -ne 'NotPresent'){throw 'Added server capability removal not confirmed'}
    Remove-Item -LiteralPath $root -Recurse -Force
    $report.cleanup=@('private service stopped/deleted','owned sshd exit verified','private user/profile removed','added server capability removed','private keys removed')
  } catch {$report.status='failed';$report.cleanup=@('cleanup unverifiable; discard ephemeral runner');$report.cleanupError=$_.Exception.Message}
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Receipt -Encoding utf8
}
if($report.status -ne 'passed'){throw 'Native OpenSSH qualification failed; inspect sanitized receipt'}
