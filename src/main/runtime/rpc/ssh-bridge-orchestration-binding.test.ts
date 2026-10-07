import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationDb } from '../orchestration/db'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcResponse } from './core'
import { RpcDispatcher } from './dispatcher'
import { createOrchestrationRpcHarness } from './methods/orchestration/rpc-test-harness'
import type { RpcCallerScope } from './rpc-caller-scope'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'

const HOST_BOUND: RpcCallerScope = {
  kind: 'ssh-bridge',
  targetId: 'box-1',
  remoteCliControl: false
}
const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SIBLING_PANE = 'tab_sibling:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LOCAL_PANE = 'tab_local:dddddddd-dddd-4ddd-8ddd-dddddddddddd'

// A worker on the relay-route SSH host, a sibling on another host, and a local coordinator.
const HOSTS: Record<string, string> = {
  term_worker: 'ssh:box-1',
  term_box_peer: 'ssh:box-1',
  term_coord: 'local',
  term_local: 'local',
  term_sibling: 'ssh:box-2'
}

describe('SSH bridge orchestration without the per-host opt-in', () => {
  const harness = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  afterEach(() => harness.cleanup())

  function setup(): void {
    ;({ db, runtime } = harness.setup())
    const panes: Record<string, string> = {
      term_coord: harness.coordinatorPaneKey,
      term_worker: WORKER_PANE,
      term_sibling: SIBLING_PANE,
      term_local: LOCAL_PANE
    }
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) => panes[handle] ?? null)
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockImplementation(
      (paneKey) => Object.keys(panes).find((handle) => panes[handle] === paneKey) ?? null
    )
    vi.spyOn(runtime, 'showTerminal').mockImplementation(async (handle) => {
      const host = HOSTS[handle]
      if (!host) {
        throw new Error('terminal_not_found')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the binding reads only executionHostId.
      return { handle, executionHostId: host } as Awaited<
        ReturnType<OrcaRuntimeService['showTerminal']>
      >
    })
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')
  }

  function dispatchFromCoordinator(name: string, paneKey: string) {
    const task = db.createTask({ spec: `${name} work` })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'terminal', handle: 'term_coord', paneKey: harness.coordinatorPaneKey },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: `term_${name}`,
      paneKey,
      processIncarnation: `runtime_test:term_${name}:1`,
      worktreeId: `repo::${name}`,
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { taskId: task.id, dispatchId: started.dispatch.id }
  }

  function callAsBridge(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    return new RpcDispatcher({ runtime }).dispatch(
      {
        id: `req-${method}`,
        authToken: 'unused',
        method,
        params,
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
      },
      { callerScope: HOST_BOUND }
    )
  }

  function forbidden(response: RpcResponse): boolean {
    return !response.ok && response.error.code === 'forbidden'
  }

  it('lets a worker on the host report worker_done to the local coordinator that dispatched it', async () => {
    setup()
    const worker = dispatchFromCoordinator('worker', WORKER_PANE)
    const response = await callAsBridge('orchestration.send', {
      from: 'term_worker',
      senderPaneKey: WORKER_PANE,
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ ...worker, outcome: 'succeeded' })
    })
    expect(response).toMatchObject({ ok: true, result: { lifecycle: { action: 'completed' } } })
    expect(db.getTask(worker.taskId)?.status).toBe('completed')
  })

  it('lets that worker check its own mailbox and message its coordinator by handle', async () => {
    setup()
    dispatchFromCoordinator('worker', WORKER_PANE)
    expect((await callAsBridge('orchestration.check', { terminal: 'term_worker' })).ok).toBe(true)
    expect((await callAsBridge('orchestration.inbox', { terminal: 'term_worker' })).ok).toBe(true)
    const status = await callAsBridge('orchestration.send', {
      from: 'term_worker',
      to: 'term_coord',
      subject: 'progress',
      type: 'status'
    })
    expect(forbidden(status)).toBe(false)
  })

  it.each<[string, string, Record<string, unknown>]>([
    ['a sender on another host', 'orchestration.send', { from: 'term_sibling', subject: 'x' }],
    ['a sender with no handle', 'orchestration.send', { subject: 'x' }],
    [
      "a sibling's pane key",
      'orchestration.send',
      { from: 'term_worker', senderPaneKey: SIBLING_PANE, subject: 'x' }
    ],
    [
      'a local terminal that is not its coordinator',
      'orchestration.send',
      {
        from: 'term_worker',
        to: 'term_local',
        subject: 'x'
      }
    ],
    ['a group address', 'orchestration.send', { from: 'term_worker', to: '@all', subject: 'x' }],
    ["another host's mailbox", 'orchestration.check', { terminal: 'term_sibling' }],
    ['an unscoped inbox', 'orchestration.inbox', {}],
    [
      "a local terminal's question",
      'orchestration.ask',
      {
        from: 'term_local',
        question: 'Proceed?'
      }
    ]
  ])('refuses %s', async (_case, method, params) => {
    setup()
    dispatchFromCoordinator('worker', WORKER_PANE)
    expect(forbidden(await callAsBridge(method, params))).toBe(true)
  })

  it("refuses a report that names another worker's Dispatch", async () => {
    setup()
    dispatchFromCoordinator('worker', WORKER_PANE)
    const sibling = dispatchFromCoordinator('sibling', SIBLING_PANE)
    const response = await callAsBridge('orchestration.send', {
      from: 'term_worker',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ ...sibling, outcome: 'succeeded' })
    })
    expect(forbidden(response)).toBe(true)
    expect(db.getTask(sibling.taskId)?.status).toBe('dispatched')
  })

  it('refuses a run the caller is no party to', async () => {
    setup()
    dispatchFromCoordinator('worker', WORKER_PANE)
    const other = db.createRun({
      objective: 'Other',
      coordinatorHandle: 'term_local',
      coordinatorPaneKey: LOCAL_PANE
    })
    const response = await callAsBridge('orchestration.check', {
      terminal: 'term_box_peer',
      run: other.id
    })
    expect(forbidden(response)).toBe(true)
  })
})
