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
}): LaunchHost {
  const runsElsewhere = args.isRemote || args.paired
  return {
    paired: args.paired,
    provesAgentInFront: (runsElsewhere ? args.launchPlatform : args.hostPlatform) !== 'win32',
    takesLaunchFile: !args.paired && !(args.isRemote && args.launchPlatform === 'win32')
  }
}
