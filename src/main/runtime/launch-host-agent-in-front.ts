/**
 * Whether the execution host can prove a launched agent holds its terminal before a paste
 * (`launched-agent-foreground`). A Windows host cannot, and a local WSL pane runs on one; an SSH
 * host is judged by its own platform.
 */
export function launchHostProvesAgentInFront(args: {
  isRemote: boolean
  launchPlatform: NodeJS.Platform
  hostPlatform?: NodeJS.Platform
}): boolean {
  return args.isRemote
    ? args.launchPlatform !== 'win32'
    : (args.hostPlatform ?? process.platform) !== 'win32'
}
