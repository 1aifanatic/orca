import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { ORCHESTRATION_METHODS } from '../../orchestration'

// Why: a federated worker terminal is created from an agent id. Passing that id
// as a shell command launched Cursor's desktop app instead of `cursor-agent`
// (issue #11926), so the remote path must resolve through the TUI agent config
// exactly like the local one.
describe('federated worker agent launch', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  async function startFederatedWorker(extraParams: Record<string, unknown> = {}) {
    const workerDb = new OrchestrationDb(':memory:')
    db = workerDb
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(workerDb)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'folder:remote-workspace'
    } as never)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      worktreeId: 'folder:remote-workspace',
      title: 'worker'
    })
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the attach reads only `worktreeId` from the shown terminal.
      { handle: 'term_remote_worker', worktreeId: 'folder:remote-workspace' } as never
    )
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    // Why: without a stable pane the handler bails at agent_readiness, so the
    // assertions below would pass against a worker that never actually started.
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_remote:leaf_remote')
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(
      'runtime_test:term_remote_worker:1'
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_remote_worker',
      accepted: true,
      bytesWritten: 1
    })
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )
    if (!method) {
      throw new Error('federationAttachStart method is not registered')
    }

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler returns the attach receipt; only these fields are asserted.
    const result = (await method.handler(
      method.params!.parse({
        runId: 'run-home',
        dispatchId: 'ctx_remote',
        taskId: 'task_remote',
        taskSpec: 'remote cursor worker',
        depth: 2,
        protocolVersion: 3,
        worktree: 'folder:remote-workspace',
        ...extraParams
      }),
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'home_peer',
          requestId: 'request_remote',
          method: 'orchestration.federationAttachStart',
          payloadHash: 'remote_payload'
        }
      }
    )) as {
      state: string
      failedStage?: string
      lastError?: string
      launch: unknown
    }
    return { runtime, createTerminal, result, workerDb }
  }

  it('creates an exact folder worker terminal from the agent id, never as a command', async () => {
    const { runtime, createTerminal, result, workerDb } = await startFederatedWorker({
      agent: 'cursor',
      model: 'gpt-5.3-codex',
      effort: 'high'
    })

    // Why: assert the worker actually reached ready — a spy-only assertion would
    // stay green even if every stage after terminal_create regressed.
    expect(result).toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'cursor', model: 'gpt-5.3-codex', effort: 'high' },
        effective: { agent: 'cursor', model: 'gpt-5.3-codex', effort: 'high' }
      }
    })
    expect(workerDb.getRemoteDispatchAttachment('ctx_remote')?.depth).toBe(2)
    // Why: the brief waits for the agent to take input, not only for tui-idle.
    expect(runtime.waitForTerminal).toHaveBeenCalledWith('term_remote_worker', {
      condition: 'tui-idle',
      timeoutMs: expect.any(Number),
      acceptComposerReady: true
    })
    expect(createTerminal).toHaveBeenCalledWith(
      'id:folder:remote-workspace',
      expect.objectContaining({
        startupAgent: 'cursor',
        launchPreferences: { model: 'gpt-5.3-codex', effort: 'high' }
      })
    )
    expect(createTerminal).toHaveBeenCalledWith(
      'id:folder:remote-workspace',
      expect.not.objectContaining({ command: expect.anything() })
    )
  })

  it('asks a reused worker terminal for idle, not for a mounted composer', async () => {
    const { runtime, createTerminal } = await startFederatedWorker({
      terminal: 'term_remote_worker'
    })

    // Its agent was running before this attach and may be mid-turn.
    expect(createTerminal).not.toHaveBeenCalled()
    expect(runtime.waitForTerminal).toHaveBeenCalledWith('term_remote_worker', {
      condition: 'tui-idle',
      timeoutMs: expect.any(Number),
      acceptComposerReady: false
    })
  })
})
