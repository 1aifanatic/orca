import { expect } from 'vitest'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { retrySshOwnerRecoveryWhileBlocked } from './ssh-owner-recovery-retry'
import { openSshPtyConsumerSession } from './ssh-pty-consumer-session'
import type { RelayDeployResult } from './ssh-relay-deploy'

export type TerminalProbe = { input: string; expect: string }

export type TerminalProbeDiagnostic = {
  event: 'spawned' | 'input-requested' | 'transport-settled' | 'output' | 'finished'
  at: number
  ptyId?: string
  incarnationId?: string
  bytes?: number
  outcome?: string
  reason?: string
  expectedObserved?: boolean
}

/** Resends the probe this often until the shell evaluates it; typeahead before a prompt can be dropped. */
const TERMINAL_PROBE_RESEND_MS = 15_000

/**
 * Opens a PTY as the session owner and waits for the shell to evaluate what it was sent. Returns
 * the multiplexer's disposer: until called, the session keeps answering relay keepalives, as the
 * app does, so the relay never reaps it as silent while the connection is still up.
 */
export async function assertTerminalEchoes(
  deployed: RelayDeployResult,
  clientInstanceId: string,
  probe: TerminalProbe,
  diagnostics?: TerminalProbeDiagnostic[]
): Promise<() => void> {
  const record = (event: TerminalProbeDiagnostic): void => {
    if (diagnostics && diagnostics.length < 128) {
      diagnostics.push(event)
    }
  }
  const mux = new SshChannelMultiplexer(deployed.transport)
  let keepOpen = false
  try {
    // Why retry: the first connect's owner stays held for its grace period, and the app retries too.
    await retrySshOwnerRecoveryWhileBlocked(
      () =>
        openSshPtyConsumerSession(mux, {
          clientInstanceId,
          expectedServerBuildId: deployed.serverBuildId
        }),
      { isCurrent: () => true, onClosed: () => () => {} }
    )
    const output = new Map<string, string>()
    mux.onNotificationByMethod('pty.data', (params) => {
      if (typeof params.id === 'string' && typeof params.data === 'string') {
        output.set(params.id, (output.get(params.id) ?? '') + params.data)
        record({
          event: 'output',
          at: Date.now(),
          ptyId: params.id,
          bytes: Buffer.byteLength(params.data),
          expectedObserved: (output.get(params.id) ?? '').includes(probe.expect)
        })
      }
    })
    const spawned: unknown = await mux.request('pty.spawn', {
      cols: 80,
      rows: 24,
      ...(diagnostics ? { env: { ORCA_SSH_INPUT_DIAGNOSTICS: '1' } } : {})
    })
    const id =
      spawned && typeof spawned === 'object' && 'id' in spawned && typeof spawned.id === 'string'
        ? spawned.id
        : ''
    expect(id).not.toBe('')
    record({
      event: 'spawned',
      at: Date.now(),
      ptyId: id,
      ...(spawned &&
      typeof spawned === 'object' &&
      'incarnationId' in spawned &&
      typeof spawned.incarnationId === 'string'
        ? { incarnationId: spawned.incarnationId }
        : {})
    })
    // Why 90s: a first Windows PowerShell start under ConPTY can take tens of seconds on CI.
    const deadline = Date.now() + 90_000
    let nextSendAt = 0
    while (!(output.get(id) ?? '').includes(probe.expect) && Date.now() < deadline) {
      if (Date.now() >= nextSendAt) {
        record({
          event: 'input-requested',
          at: Date.now(),
          ptyId: id,
          bytes: Buffer.byteLength(probe.input)
        })
        if (diagnostics) {
          mux.notifyWithSettlement('pty.data', { id, data: probe.input }, (result) => {
            record({
              event: 'transport-settled',
              at: Date.now(),
              ptyId: id,
              outcome: result.outcome,
              ...(result.outcome === 'accepted' ? {} : { reason: result.reason })
            })
          })
        } else {
          mux.notify('pty.data', { id, data: probe.input })
        }
        nextSendAt = Date.now() + TERMINAL_PROBE_RESEND_MS
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    record({
      event: 'finished',
      at: Date.now(),
      ptyId: id,
      expectedObserved: (output.get(id) ?? '').includes(probe.expect)
    })
    expect(output.get(id) ?? '').toContain(probe.expect)
    await mux.request('pty.shutdown', { id })
    keepOpen = true
    return () => mux.dispose()
  } finally {
    if (!keepOpen) {
      mux.dispose()
    }
  }
}
