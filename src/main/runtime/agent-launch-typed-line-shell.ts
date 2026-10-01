import { basename } from 'node:path'

/**
 * The shell a local pane's startup line gets typed into, named before the spawn the way the spawn
 * picks it: the request's shell, the default-shell setting, then `SHELL`
 * (`ipc/pty/runtime/spawn-preflight.ts`, then the local or daemon launch plan).
 *
 * Undefined where the host cannot name it: a remote host, whose relay picks its own login shell,
 * and Windows, whose pane may be cmd, PowerShell, Git Bash or a WSL distro.
 */
export function nameLocalTypedLineShell(args: {
  isRemote: boolean
  shellOverride?: string
  defaultShellSetting?: string
  platform?: NodeJS.Platform
  envShell?: string
}): string | undefined {
  if (args.isRemote || (args.platform ?? process.platform) === 'win32') {
    return undefined
  }
  const shellPath =
    args.shellOverride?.trim() ||
    args.defaultShellSetting?.trim() ||
    (args.envShell ?? process.env.SHELL) ||
    '/bin/zsh'
  return basename(shellPath).toLowerCase()
}
