/**
 * The steal's exited-holder condition, as each host's command reads it: `*Check` before the steal
 * claim, `*ClaimCheck` inside it, and `*Release` where the claim is cleaned up.
 */
import { shellEscape } from './ssh-connection-utils'
import type { InstallLockOwnerFile } from './ssh-relay-install-lock-commands'
import { powerShellLiteral } from './ssh-remote-powershell'

/**
 * A lock whose owner file still names `token` once it has been quiet past `quietSeconds`: the
 * caller proved that holder exited, and the steal checks both inside its arbitration (BUG-23).
 * With `mutationLock`, the steal also holds that state-mutation lock across the takeover, so no
 * mutation can be admitted under the fence it replaces.
 */
export type InstallLockExitedOwner = InstallLockOwnerFile & {
  quietSeconds: number
  mutationLock?: string
}

export function posixCheck(
  lockDir: string,
  exitedOwner: InstallLockExitedOwner | undefined,
  ageVariable: string,
  variableName: string
): string {
  if (!exitedOwner) {
    return `${variableName}=0;`
  }
  const ownerPath = shellEscape(`${lockDir.replace(/\/+$/u, '')}/${exitedOwner.fileName}`)
  return (
    `${variableName}=0; if [ "$(cat ${ownerPath} 2>/dev/null)" = ${shellEscape(exitedOwner.token)} ] && ` +
    `[ "\${${ageVariable}:-0}" -gt ${exitedOwner.quietSeconds} ] 2>/dev/null; then ${variableName}=1; fi;`
  )
}

export function windowsCheck(
  exitedOwner: InstallLockExitedOwner | undefined,
  ageExpression: string,
  variableName: string
): string {
  if (!exitedOwner) {
    return `${variableName} = $false`
  }
  const ownerPath = `(Join-Path $lock ${powerShellLiteral(exitedOwner.fileName)})`
  return (
    `${variableName} = $false; try { ${variableName} = (${ageExpression} -gt ${exitedOwner.quietSeconds}) -and ` +
    `([System.IO.File]::ReadAllText(${ownerPath}) -ceq ${powerShellLiteral(exitedOwner.token)}) } catch {}`
  )
}

/**
 * Inside the steal claim: takes the state-mutation lock, which a mutation must hold before it
 * rechecks its fence, then rereads the owner and only then the lock's identity, so a heartbeat
 * or a re-owning after the first sample fails the takeover. Any existing mutation lock, live,
 * unverifiable or dead, refuses: its removal could race a mutation taking it over.
 */
function posixMutationAdmission(
  lockDir: string,
  exitedOwner: InstallLockExitedOwner | undefined,
  identityAssignment: (lockDir: string, variableName: string) => string
): string {
  if (!exitedOwner?.mutationLock) {
    return ''
  }
  const ownerPath = shellEscape(`${lockDir.replace(/\/+$/u, '')}/${exitedOwner.fileName}`)
  return [
    'if [ "$current_exited" = 1 ]; then current_exited=0;',
    `if mkdir ${shellEscape(exitedOwner.mutationLock)} 2>/dev/null; then held_mutation=${shellEscape(exitedOwner.mutationLock)};`,
    `[ "$(cat ${ownerPath} 2>/dev/null)" = ${shellEscape(exitedOwner.token)} ] &&`,
    `${identityAssignment(lockDir, 'again_key')} && [ "$again_key" = "$lock_key" ] && current_exited=1;`,
    'fi; fi;'
  ].join(' ')
}

/** Releases only a mutation lock this steal created: `rmdir` keeps one a mutation now holds. */
export function posixRelease(exitedOwner: InstallLockExitedOwner | undefined): string {
  return exitedOwner?.mutationLock ? ' [ -z "$held_mutation" ] || rmdir "$held_mutation";' : ''
}

/**
 * The Windows admission: the host script's mutation lock is owned by whoever creates its
 * `owner.json` exclusively, so this claims that file; its live pid without a creation time
 * reads as unverifiable, which keeps every mutation out until the steal removes it.
 */
function windowsMutationAdmission(exitedOwner: InstallLockExitedOwner | undefined): string[] {
  if (!exitedOwner?.mutationLock) {
    return []
  }
  const mutation = powerShellLiteral(exitedOwner.mutationLock)
  const ownerPath = `(Join-Path $lock ${powerShellLiteral(exitedOwner.fileName)})`
  return [
    '$heldMutation = $null',
    'if ($currentExited) { $currentExited = $false; try {',
    `$null = New-Item -ItemType Directory -Force -Path ${mutation} -ErrorAction Stop`,
    `$mutationStream = [System.IO.File]::Open((Join-Path ${mutation} 'owner.json'), [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)`,
    `$heldMutation = ${mutation}`,
    `try { $mutationOwner = [System.Text.Encoding]::UTF8.GetBytes('{"pid":' + $PID + '}'); $mutationStream.Write($mutationOwner, 0, $mutationOwner.Length) } finally { $mutationStream.Dispose() }`,
    `$ownerNow = [System.IO.File]::ReadAllText(${ownerPath})`,
    '$again = Get-Item -LiteralPath $lock -ErrorAction Stop',
    '$againIdentity = "$(([DateTimeOffset]$again.LastWriteTimeUtc).ToUnixTimeSeconds()):$($again.CreationTimeUtc.Ticks)"',
    `$currentExited = ($ownerNow -ceq ${powerShellLiteral(exitedOwner.token)}) -and ($againIdentity -eq $lockIdentity)`,
    '} catch {} }'
  ]
}

export function windowsRelease(exitedOwner: InstallLockExitedOwner | undefined): string[] {
  return exitedOwner?.mutationLock
    ? [
        'if ($null -ne $heldMutation) { Remove-Item -LiteralPath $heldMutation -Recurse -Force -ErrorAction SilentlyContinue }'
      ]
    : []
}

export function posixClaimCheck(
  lockDir: string,
  exitedOwner: InstallLockExitedOwner | undefined,
  identityAssignment: (lockDir: string, variableName: string) => string
): string {
  return [
    posixCheck(lockDir, exitedOwner, 'current_age', 'current_exited'),
    posixMutationAdmission(lockDir, exitedOwner, identityAssignment)
  ].join(' ')
}

export function windowsClaimCheck(exitedOwner: InstallLockExitedOwner | undefined): string[] {
  return [
    windowsCheck(exitedOwner, '($currentNow - $currentMtime)', '$currentExited'),
    ...windowsMutationAdmission(exitedOwner)
  ]
}
