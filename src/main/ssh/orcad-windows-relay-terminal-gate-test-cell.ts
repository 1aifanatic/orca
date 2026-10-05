/**
 * The conversion's terminal gate against a real relay on a Windows SSH host, for the orcad host
 * lane: deploy the pinned relay, run one terminal, prove the gate reads it as live, stop it, and
 * prove the gate then reads the host as exited. The relay is asked through `pty.listProcesses`,
 * exactly as `orcadMigrationRelayPtyLister` asks it through the SSH PTY provider.
 */
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import type { SshConnection } from './ssh-connection'
import { deployOnce } from './ssh-hostile-host-test-harness'
import { retrySshOwnerRecoveryWhileBlocked } from './ssh-owner-recovery-retry'
import { openSshPtyConsumerSession } from './ssh-pty-consumer-session'
import { assessOrcadMigrationTerminals } from './orcad-migration-terminal-gate'
import { listPreviousRelayPtyIds } from './ssh-legacy-relay-routing'
import { clearPreviousRelayCensus, startPreviousRelayCensus } from './ssh-previous-relay-terminals'

function relayPtyIds(rows: unknown): string[] {
  return Array.isArray(rows)
    ? rows.flatMap((row: unknown) =>
        row && typeof row === 'object' && 'id' in row && typeof row.id === 'string' ? [row.id] : []
      )
    : []
}

export async function proveWindowsRelayTerminalGate(
  conn: SshConnection,
  targetId: string
): Promise<Record<string, unknown>> {
  const relay = await deployOnce(conn)
  expect(relay.error, String(relay.error)).toBeNull()
  const deployed = relay.deployed!
  const mux = new SshChannelMultiplexer(deployed.transport)
  try {
    await retrySshOwnerRecoveryWhileBlocked(
      () =>
        openSshPtyConsumerSession(mux, {
          clientInstanceId: randomUUID(),
          expectedServerBuildId: deployed.serverBuildId
        }),
      { isCurrent: () => true, onClosed: () => () => {} }
    )
    // Earlier relays answer through this deploy's real Windows census, as a connect asks them.
    await startPreviousRelayCensus(conn, targetId, deployed)
    const lister = Object.assign(async () => relayPtyIds(await mux.request('pty.listProcesses')), {
      previous: () => listPreviousRelayPtyIds(targetId)
    })
    const noLeases = { getSshRemotePtyLeases: () => [] }
    const spawned: unknown = await mux.request('pty.spawn', { cols: 80, rows: 24 })
    const id = relayPtyIds([spawned])[0] ?? ''
    expect(id).not.toBe('')
    const live = await assessOrcadMigrationTerminals(noLeases, targetId, lister)
    expect(live).toMatchObject({ verdict: 'live', ptyIds: [id] })
    await mux.request('pty.shutdown', { id, immediate: true })
    const deadline = Date.now() + 30_000
    while ((await lister()).length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const exited = await assessOrcadMigrationTerminals(noLeases, targetId, lister)
    expect(exited).toEqual({ verdict: 'exited', provenPtyIds: [] })
    return { relayTerminal: id, gateLive: live.verdict, gateExited: exited.verdict }
  } finally {
    clearPreviousRelayCensus(targetId)
    mux.dispose()
  }
}
