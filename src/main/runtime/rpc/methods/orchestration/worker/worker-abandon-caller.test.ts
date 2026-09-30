import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { eraseRpcMethods, type RpcContext } from '../../../core'
import { parseOrcaSessionAddress } from '../../../../../../shared/orca-session-address'

describe('orchestration.workerAbandon', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
  })
  afterEach(() => db.close())

  function readyWorker(): string {
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'abandon caller' })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 9
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      processIncarnation: 'inc_worker',
      worktreeId: 'wt',
      effects: [],
      setupState: 'not_configured'
    })
    db.markWorkerDispatchReady(dispatch.id)
    return dispatch.id
  }

  async function abandon(dispatchId: string, ctx: Partial<RpcContext>) {
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
      (m) => m.name === 'orchestration.workerAbandon'
    )!
    return method.handler(method.params!.parse({ dispatch: dispatchId }), { runtime, ...ctx })
  }

  it('records the calling terminal as the one who abandoned the worker', async () => {
    const dispatchId = readyWorker()

    await expect(
      abandon(dispatchId, { orchestrationCompatibilityEvidence: { terminalHandle: 'term_coord' } })
    ).resolves.toMatchObject({ state: 'abandoned', alreadySettled: false })
    expect(db.getWorkerDispatch(dispatchId)?.last_error).toBe('Abandoned by term_coord.')
  })

  it('prefers the resolved Orca session over the terminal environment', async () => {
    const dispatchId = readyWorker()
    const orcaSessionId = parseOrcaSessionAddress('session:chat_1')!
    const session: OrchestrationSessionCaller = {
      address: 'session:chat_1',
      terminalHandle: null,
      paneKey: null,
      orcaSessionId,
      sessionId: orcaSessionId,
      workspaceId: 'wt'
    }

    await abandon(dispatchId, {
      orchestrationCaller: session,
      orchestrationCompatibilityEvidence: { terminalHandle: 'term_coord' }
    })
    expect(db.getWorkerDispatch(dispatchId)?.last_error).toBe('Abandoned by session:chat_1.')
  })
})
