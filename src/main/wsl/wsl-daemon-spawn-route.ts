import { parseAppWslPtyId } from '../../shared/wsl-pty-id'
import type { WslAccountExecutionContext } from './wsl-account-execution-context'
import type { WslDaemonConnection, WslDaemonSessions } from './wsl-daemon-sessions'
import type { PreparedWslGuestSpawnOwner } from './wsl-guest-spawn-options'

export type WslDaemonSpawnRoute = Readonly<{
  connection: WslDaemonConnection
  execution: WslAccountExecutionContext
  prepared: PreparedWslGuestSpawnOwner
  fresh: boolean
}>

/** Existing unencoded IDs retain their Windows owner; only fresh WSL terminals change backend. */
export async function prepareWslDaemonSpawnRoute(args: {
  sessions?: Pick<WslDaemonSessions, 'prepareFresh' | 'reconnect'>
  connectionId?: string | null
  sessionId?: string
  isNewSession?: boolean
  distro?: string | null
  signal?: AbortSignal
  platform?: NodeJS.Platform
}): Promise<WslDaemonSpawnRoute | null> {
  if (args.connectionId) {
    return null
  }
  const owner = args.sessionId ? parseAppWslPtyId(args.sessionId) : null
  if (args.sessionId?.startsWith('wsl:') && !owner) {
    throw new Error('Invalid WSL terminal identity')
  }
  if (owner) {
    if (!args.sessions || (args.platform ?? process.platform) !== 'win32') {
      throw new Error('WSL terminal owner is unavailable on this host')
    }
    const connection = await args.sessions.reconnect(owner, args.signal)
    return Object.freeze({
      connection,
      prepared: Object.freeze({ owner: connection.owner, endpoint: connection.endpoint }),
      execution: Object.freeze({
        distro: connection.endpoint.distro,
        userName: connection.endpoint.userName,
        userId: connection.endpoint.userId,
        home: connection.endpoint.home
      }),
      fresh: false
    })
  }
  if (
    (args.sessionId && args.isNewSession !== true) ||
    !args.sessions ||
    !args.distro ||
    (args.platform ?? process.platform) !== 'win32'
  ) {
    return null
  }
  const fresh = await args.sessions.prepareFresh(args.distro, args.signal)
  return Object.freeze({ ...fresh, fresh: true })
}
