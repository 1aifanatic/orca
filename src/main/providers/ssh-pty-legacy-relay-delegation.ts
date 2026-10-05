/**
 * Lets the target's provider hand a PTY to an earlier build's relay that still runs it.
 *
 * Every per-PTY caller resolves the target's one registered provider, so routing lives here rather
 * than at each call site: a reattach the current relay answered with
 * {@link SshPtyHeldByPreviousRelayError} is retried through the old relay, and once that pane is
 * served there, every later operation on its id goes to the same relay.
 */
import { SshPtyHeldByPreviousRelayError } from './ssh-pty-errors'
import { toAppSshPtyId } from './ssh-pty-id'
import type { SshPtyProvider } from './ssh-pty-provider'
import type { SshPtyAttachResult } from './ssh-pty-session-reattach'
import type { PtySpawnOptions, PtySpawnResult } from './types'

export type SshPtyLegacyRelayRouting = {
  /** The served route for a held PTY, or null when no older relay holds it. */
  attach: (appPtyId: string) => Promise<{ provider: SshPtyProvider; release: () => void } | null>
  providerFor: (appPtyId: string) => SshPtyProvider | undefined
  servedProviders: () => SshPtyProvider[]
  dispose: () => void
}

const routingByProvider = new WeakMap<SshPtyProvider, SshPtyLegacyRelayRouting>()

/**
 * The reconnect path's counterpart to the delegated spawn: a reattach the current relay disowned is
 * retried through the older relay that holds it. Null when no older relay serves the PTY.
 */
export async function attachHeldPtyThroughPreviousRelay(
  provider: SshPtyProvider,
  appPtyId: string,
  expected?: { paneKey?: string; tabId?: string }
): Promise<SshPtyAttachResult | null> {
  const served = await routingByProvider.get(provider)?.attach(appPtyId)
  if (!served) {
    return null
  }
  try {
    return await served.provider.attachForReconnect(appPtyId, expected)
  } catch (error) {
    served.release()
    throw error
  }
}

export function installSshPtyLegacyRelayDelegation(
  provider: SshPtyProvider,
  routing: SshPtyLegacyRelayRouting
): void {
  // Why: a second install would wrap the wrappers and route through two routing tables.
  if (routingByProvider.has(provider)) {
    throw new Error('ssh_pty_legacy_relay_routing_already_installed')
  }
  routingByProvider.set(provider, routing)
  const own = {
    dispose: provider.dispose.bind(provider),
    spawn: provider.spawn.bind(provider),
    attach: provider.attach.bind(provider),
    attachForReconnect: provider.attachForReconnect.bind(provider),
    shutdown: provider.shutdown.bind(provider),
    pauseProducer: provider.pauseProducer.bind(provider),
    resumeProducer: provider.resumeProducer.bind(provider),
    listProcesses: provider.listProcesses,
    write: provider.write,
    writeWithSettlement: provider.writeWithSettlement,
    resize: provider.resize,
    sendSignal: provider.sendSignal,
    getCwd: provider.getCwd,
    getInitialCwd: provider.getInitialCwd,
    clearBuffer: provider.clearBuffer,
    resetInputModes: provider.resetInputModes,
    closeStartupQueryAuthority: provider.closeStartupQueryAuthority,
    acknowledgeDataEvent: provider.acknowledgeDataEvent,
    hasChildProcesses: provider.hasChildProcesses,
    getForegroundProcess: provider.getForegroundProcess,
    inspectProcess: provider.inspectProcess,
    hasPty: provider.hasPty,
    getAppliedSize: provider.getAppliedSize,
    serialize: provider.serialize,
    providesAgentSessionOwnerListings: provider.providesAgentSessionOwnerListings.bind(provider)
  }
  // Why normalized: the reconnect path names a PTY in relay form, panes in app form.
  const routed = (id: string): SshPtyProvider | undefined => {
    try {
      return routing.providerFor(toAppSshPtyId(provider.getConnectionId(), id))
    } catch {
      return undefined
    }
  }

  provider.dispose = () => {
    routing.dispose()
    own.dispose()
  }

  provider.spawn = async (opts: PtySpawnOptions): Promise<PtySpawnResult> => {
    try {
      return await own.spawn(opts)
    } catch (error) {
      if (!(error instanceof SshPtyHeldByPreviousRelayError) || !opts.sessionId) {
        throw error
      }
      const served = await routing.attach(opts.sessionId)
      if (!served) {
        throw error
      }
      try {
        return await served.provider.spawn(opts)
      } catch (legacyError) {
        served.release()
        throw legacyError
      }
    }
  }
  provider.attach = (id) => routed(id)?.attach(id) ?? own.attach(id)
  provider.attachForReconnect = (id, expected, recovery) =>
    routed(id)?.attachForReconnect(id, expected, recovery) ??
    own.attachForReconnect(id, expected, recovery)
  provider.shutdown = (id, opts) => routed(id)?.shutdown(id, opts) ?? own.shutdown(id, opts)
  provider.pauseProducer = (id) => (routed(id) ?? own).pauseProducer(id)
  provider.resumeProducer = (id) => (routed(id) ?? own).resumeProducer(id)
  provider.write = (id, data) => routed(id)?.write(id, data) ?? own.write(id, data)
  provider.writeWithSettlement = (id, data) =>
    routed(id)?.writeWithSettlement(id, data) ?? own.writeWithSettlement(id, data)
  provider.resize = (id, cols, rows) => (routed(id) ?? own).resize(id, cols, rows)
  provider.sendSignal = (id, signal) =>
    routed(id)?.sendSignal(id, signal) ?? own.sendSignal(id, signal)
  provider.getCwd = (id) => routed(id)?.getCwd(id) ?? own.getCwd(id)
  provider.getInitialCwd = (id) => routed(id)?.getInitialCwd(id) ?? own.getInitialCwd(id)
  provider.clearBuffer = (id) => routed(id)?.clearBuffer(id) ?? own.clearBuffer(id)
  provider.resetInputModes = (id) => routed(id)?.resetInputModes(id) ?? own.resetInputModes(id)
  provider.closeStartupQueryAuthority = (id) =>
    routed(id)?.closeStartupQueryAuthority(id) ?? own.closeStartupQueryAuthority(id)
  provider.acknowledgeDataEvent = (id, charCount) =>
    (routed(id) ?? own).acknowledgeDataEvent(id, charCount)
  provider.hasChildProcesses = (id) =>
    routed(id)?.hasChildProcesses(id) ?? own.hasChildProcesses(id)
  provider.getForegroundProcess = (id) =>
    routed(id)?.getForegroundProcess(id) ?? own.getForegroundProcess(id)
  provider.inspectProcess = (id, options) =>
    routed(id)?.inspectProcess(id, options) ?? own.inspectProcess(id, options)
  provider.hasPty = (id) => routed(id) !== undefined || own.hasPty(id)
  provider.getAppliedSize = (id) => (routed(id) ?? own).getAppliedSize(id)
  provider.providesAgentSessionOwnerListings = (id) =>
    (routed(id) ?? own).providesAgentSessionOwnerListings(id)
  // Why not routed: revive replays onto this relay and would respawn a PTY the older one still runs.
  provider.serialize = (ids) => own.serialize(ids.filter((id) => routed(id) === undefined))
  // Why merged, and rejecting when an older relay cannot answer: a served PTY missing from the
  // listing reads as exited to inventory, and a relay we could not ask proves nothing.
  provider.listProcesses = async (options) => {
    const [current, ...previous] = await Promise.all([
      own.listProcesses(options),
      ...routing
        .servedProviders()
        .map((legacy) =>
          legacy
            .listProcesses(options)
            .then((rows) => rows.filter((row) => routed(row.id) === legacy))
        )
    ])
    return [...current, ...previous.flat()]
  }
}
