/**
 * `agent.launch` with a `create-folder-workspace` target: the host creates the folder workspace,
 * then starts the agent in it exactly as it would in a folder workspace that already existed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import {
  CAPABLE_CLIENT,
  methodNamed,
  rpcContext,
  runtimeStub,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

const createStructuredSession = vi.fn(async (_args: Record<string, unknown>) => ({
  ok: true as const,
  value: { sessionId: 'sess-1' }
}))

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (args: Record<string, unknown>) =>
    createStructuredSession(args)
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')

const FOLDER_LAUNCH = {
  agent: 'claude',
  target: {
    kind: 'create-folder-workspace',
    create: { projectGroupId: 'group-1', name: 'notes', createdWithAgent: 'codex' }
  }
}

function launch(params: unknown, runtime: AgentLaunchRuntimeStub, context: Partial<RpcContext>) {
  return AGENT_LAUNCH.handler(AGENT_LAUNCH.params.parse(params), rpcContext(runtime, context))
}

beforeEach(() => {
  createStructuredSession.mockClear()
})

describe('agent.launch creating a folder workspace', () => {
  it('creates the workspace, then starts a terminal agent in it', async () => {
    const runtime = runtimeStub({ settings: {} })

    const result = await launch(FOLDER_LAUNCH, runtime, CAPABLE_CLIENT)

    expect(runtime.createFolderWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectGroupId: 'group-1',
        name: 'notes',
        // The launch's agent, not the one the create payload named.
        createdWithAgent: 'claude',
        creatorProvenance: expect.anything()
      })
    )
    expect(runtime.showTerminalWorkspaceLaunchScope).toHaveBeenCalledWith('id:folder:fw-new')
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.createTerminal).toHaveBeenCalledWith('id:folder:fw-new', expect.anything())
    expect(result).toMatchObject({
      worktreeId: 'folder:fw-new',
      outcome: { kind: 'terminal', handle: 'term_1' }
    })
  })

  it('opens a structured chat in the new workspace when that is the default', async () => {
    const runtime = runtimeStub()

    const result = await launch(FOLDER_LAUNCH, runtime, CAPABLE_CLIENT)

    expect(createStructuredSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: 'id:folder:fw-new' })
    )
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(result).toMatchObject({ worktreeId: 'folder:fw-new', outcome: { kind: 'structured' } })
  })

  it('rejects a folder create with no project group, the same as folderWorkspace.create', () => {
    const parsed = AGENT_LAUNCH.params.safeParse({
      agent: 'claude',
      target: { kind: 'create-folder-workspace', create: { name: 'notes' } }
    })
    expect(parsed.success).toBe(false)
  })
})
