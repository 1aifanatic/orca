// Orca Relay — remote-host daemon and reconnect bridge entry point.

import { parseRelayLaunchOptions, readRelayEndpointCredential } from './relay-launch-options'
import { runRelayConnectChannel } from './relay-connect-channel'
import { runRelayOrcaCliChannel } from './relay-orca-cli-channel'
import { runRelayDaemon } from './relay-daemon'
import { relayLogLine } from './relay-diagnostic-log'
import { configureRelayBundledRipgrep } from './relay-bundled-ripgrep'
import { launchDetachedWindowsRelay } from './windows-detached-launch'

async function main(): Promise<void> {
  const options = parseRelayLaunchOptions(process.argv)
  if (options.connectMode) {
    runRelayConnectChannel(options.sockPath, readRelayEndpointCredential(options.credentialFile))
    return
  }
  if (options.cliMode) {
    const marker = process.argv.indexOf('--orca-cli')
    await runRelayOrcaCliChannel(
      options.sockPath,
      marker === -1 ? [] : process.argv.slice(marker + 1),
      readRelayEndpointCredential(options.credentialFile)
    )
    return
  }
  if (options.spawnDetachedMode) {
    const marker = process.argv.indexOf('--spawn-detached')
    const args = marker === -1 ? [] : process.argv.slice(marker + 1)
    const commandMarker = args.indexOf('--spawn-command')
    if (commandMarker === -1 || !args[commandMarker + 1]) {
      throw new Error('Detached launch command is unavailable')
    }
    const command = args[commandMarker + 1]
    const comspec = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'
    const pid = launchDetachedWindowsRelay(comspec, ['/d', '/s', '/c', command], process.cwd())
    process.stdout.write(`launched ${pid}\n`)
    return
  }
  configureRelayBundledRipgrep(options.ripgrepPath)
  // Why no read here: the daemon publishes its credential itself, after it owns the socket.
  await runRelayDaemon(options)
}

void main().catch((error) => {
  relayLogLine(
    `[relay] Fatal startup error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
  )
  process.exit(1)
})
