# Read-only capability observation on an ephemeral windows-11-arm runner; no service changes.
$ErrorActionPreference = 'Stop'
function Get-PeMachine([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $stream = [IO.File]::OpenRead($Path)
  try {
    $reader = [IO.BinaryReader]::new($stream)
    $stream.Position = 0x3c
    $offset = $reader.ReadInt32()
    $stream.Position = $offset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw 'Not a PE image' }
    return ('0x{0:X4}' -f $reader.ReadUInt16())
  } finally { $stream.Dispose() }
}
$directory = Join-Path $env:WINDIR 'System32\OpenSSH'
$sshd = Join-Path $directory 'sshd.exe'
$ssh = Join-Path $directory 'ssh.exe'
$service = Get-Service -Name sshd -ErrorAction SilentlyContinue
$capabilities = @(Get-WindowsCapability -Online | Where-Object Name -Like 'OpenSSH*' | ForEach-Object { @{name=$_.Name; state=[string]$_.State} })
$defaultShell = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\OpenSSH' -ErrorAction SilentlyContinue
$report = @{
  scope='read-only Windows ARM SSH server availability; not transport qualification'
  architecture=[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  imageVersion=$env:ImageVersion
  sshClient=@{exists=(Test-Path -LiteralPath $ssh); machine=(Get-PeMachine $ssh)}
  sshServer=@{exists=(Test-Path -LiteralPath $sshd); machine=(Get-PeMachine $sshd); serviceState=if($service){[string]$service.Status}else{'absent'}}
  capabilities=$capabilities
  defaultShell=if($defaultShell.DefaultShell){$defaultShell.DefaultShell}else{'cmd.exe (OpenSSH default)'}
  defaultShellCommandOption=$defaultShell.DefaultShellCommandOption
  username=$env:USERNAME
  admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
$report | ConvertTo-Json -Depth 5
if ($report.architecture -ne 'Arm64') { throw 'Requires a native ARM64 OS' }
