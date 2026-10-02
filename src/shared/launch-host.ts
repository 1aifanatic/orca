import type { GlobalSettings } from './global-settings-types'

export type WindowsPowerShell = 'powershell.exe' | 'pwsh.exe'

export type WindowsShellSettings =
  | Partial<
      Pick<GlobalSettings, 'terminalWindowsShell' | 'terminalWindowsPowerShellImplementation'>
    >
  | null
  | undefined

/** What the host a launch runs on can do with its prompt, derived in one place from where it runs. */
export type LaunchHost = {
  /** Another Orca this client drives, possibly an older one: it is sent a command it may neither
   *  stage nor accompany with a launch file. Temporary, until paired hosts advertise both. */
  paired: boolean
  /** Whether the host can prove the launched agent holds its terminal before a paste
   *  (`launched-agent-foreground`). A Windows host cannot, so #24257's guarded paste is refused. */
  provesAgentInFront: boolean
  /** Whether the host writes a launch file the agent can read. A paired Orca may be older, and an
   *  SSH Windows host's relay may run its panes in WSL (its OpenSSH default shell, which this client
   *  cannot see), where it writes none. Such a host gets the line or the paste instead. */
  takesLaunchFile: boolean
  /** The PowerShell a local Windows pane is spawned as, which decides how it hands `"` and a
   *  trailing `\` to the agent. Null where this Orca does not choose it (an SSH or paired host) or
   *  has not yet learned whether pwsh is installed. */
  windowsPowerShell: WindowsPowerShell | null
}

/**
 * The PowerShell this host spawns for a pane, resolved as the spawn resolves it: the requested
 * shell, then the implementation setting, then whether pwsh.exe is installed. Null for a shell that
 * is not PowerShell, or when that probe has not answered.
 */
export function spawnedWindowsPowerShell(args: {
  settings: WindowsShellSettings
  /** The shell this launch asked for, which outranks the setting. */
  windowsShellOverride?: string | null
  pwshAvailable: boolean | null
}): WindowsPowerShell | null {
  const shell = (args.windowsShellOverride ?? args.settings?.terminalWindowsShell ?? '').trim()
  const name = shell.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
  if (name === 'pwsh.exe' || name === 'pwsh') {
    return 'pwsh.exe'
  }
  if (name !== '' && name !== 'powershell.exe' && name !== 'powershell') {
    return null
  }
  const implementation = args.settings?.terminalWindowsPowerShellImplementation
  if (implementation === 'powershell.exe' || implementation === 'pwsh.exe') {
    return implementation
  }
  return args.pwshAvailable === null ? null : args.pwshAvailable ? 'pwsh.exe' : 'powershell.exe'
}

/**
 * The launch host's facts. An SSH or paired host is judged by its own platform, a local one (a WSL
 * pane included, whose process reads run on Windows) by the machine running this Orca.
 */
export function describeLaunchHost(args: {
  /** The platform of the shell that types the launch line. */
  launchPlatform: NodeJS.Platform
  isRemote: boolean
  /** The platform of the machine this Orca runs on. */
  hostPlatform: NodeJS.Platform
  paired: boolean
  /** `spawnedWindowsPowerShell` on this machine, which a launch elsewhere does not use. */
  windowsPowerShell?: WindowsPowerShell | null
}): LaunchHost {
  const runsElsewhere = args.isRemote || args.paired
  return {
    paired: args.paired,
    provesAgentInFront: (runsElsewhere ? args.launchPlatform : args.hostPlatform) !== 'win32',
    takesLaunchFile: !args.paired && !(args.isRemote && args.launchPlatform === 'win32'),
    windowsPowerShell:
      runsElsewhere || args.launchPlatform !== 'win32' ? null : (args.windowsPowerShell ?? null)
  }
}
