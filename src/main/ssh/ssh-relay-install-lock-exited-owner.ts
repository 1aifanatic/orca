/** The steal's exited-holder condition, as each host's command reads it. */
import { shellEscape } from './ssh-connection-utils'
import type { InstallLockOwnerFile } from './ssh-relay-install-lock-commands'
import { powerShellLiteral } from './ssh-remote-powershell'

/**
 * A lock whose owner file still names `token` once it has been quiet past `quietSeconds`: the
 * caller proved that holder exited, and the steal checks both inside its arbitration (BUG-23).
 */
export type InstallLockExitedOwner = InstallLockOwnerFile & { quietSeconds: number }

export function posixExitedOwnerAssignment(
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

export function windowsExitedOwnerAssignment(
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
