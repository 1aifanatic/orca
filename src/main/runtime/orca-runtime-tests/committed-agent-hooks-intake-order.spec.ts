import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { store, syncSinglePty } from '../orca-runtime-test-fixtures.spec'

// An agent commits a hook to disk before it prints or exits, so main applies committed hooks
// before it processes anything the pane produced: the order the blocking hook POST used to give.
describe('committed agent hooks at terminal intake', () => {
  function runtimeRecording(order: string[]) {
    const runtime = new OrcaRuntimeService(store, undefined, {
      drainCommittedAgentHooks: () => order.push('drain'),
      onTerminalAgentStatus: () => order.push('agentStatus:set'),
      onTerminalSideEffects: () => order.push('pty:sideEffect'),
      reconcileAgentStatusForEndedProcess: () => order.push('reconcile')
    })
    syncSinglePty(runtime)
    return runtime
  }

  it('drains before the status and finished-command facts parsed from output', () => {
    const order: string[] = []
    const runtime = runtimeRecording(order)

    runtime.onPtyData(
      'pty-1',
      '\x1b]9999;{"state":"done","agentType":"codex"}\x07\x1b]133;D;0\x07$ ',
      100
    )

    expect(order[0]).toBe('drain')
    expect(order).toContain('agentStatus:set')
    expect(order).toContain('pty:sideEffect')
  })

  it('drains before a finished command the daemon detected', () => {
    const order: string[] = []
    const runtime = runtimeRecording(order)
    runtime.setPtyTransientFactDelegation('pty-1', true)

    runtime.emitDaemonPtyTransientFact('pty-1', { kind: 'command-finished', exitCode: 0 })

    expect(order[0]).toBe('drain')
    expect(order).toContain('pty:sideEffect')
  })

  it('drains before an exit is reconciled', () => {
    const order: string[] = []
    const runtime = runtimeRecording(order)
    runtime.onPtyData('pty-1', '$ ', 100)
    order.length = 0

    void runtime.onPtyExit('pty-1', 0)

    expect(order[0]).toBe('drain')
  })
})
