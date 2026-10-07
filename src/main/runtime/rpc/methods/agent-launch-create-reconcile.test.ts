/**
 * A create-worktree launch whose host stopped mid-create, against the real durable ledger.
 *
 * The launch records the path it is about to add before `git worktree add`, and the workspace it
 * made before it asks for any agent. A host that stopped between the two left a workspace with no
 * agent: a restarted host replaying the launch says so, to a caller that reads it; any other caller
 * keeps the uncertain answer it always got. Past the second record an agent may exist, and a
 * workspace that never appeared may be half made, so both stay uncertain.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_AGENT_NOT_STARTED_CODE } from '../../../../shared/agent-launch-agent-not-started'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import type { RpcContext } from '../core'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

// The ledger admits against `Date.now()`, so the id must be dated now.
const OPERATION_ID = `${Date.now()}-000000000000000000000000000000c1`
const WORKTREE_PATH = '/worktrees/task'
const CREATE_LAUNCH = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } },
  operationId: OPERATION_ID
}
const CLI: Partial<RpcContext> = {}
const OLDER_PHONE: Partial<RpcContext> = {
  clientKind: 'mobile',
  pairedDeviceId: 'device-1',
  clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
}

let directory: string
let store: AgentSessionRecordStore

function launch(runtime: AgentLaunchRuntimeStub, context: Partial<RpcContext>): Promise<unknown> {
  return AGENT_LAUNCH_REPLAY.handler(
    AGENT_LAUNCH_REPLAY.params.parse(CREATE_LAUNCH),
    rpcContext(runtime, context)
  )
}

/** A host that dies inside the create, after the bookkeeping `reached` asks it to write. */
async function launchThatStopsMidCreate(
  context: Partial<RpcContext>,
  reached: 'candidate' | 'created'
): Promise<void> {
  const runtime = runtimeStub({ settings: {} })
  let stopped: () => void = () => {}
  const stoppedHere = new Promise<void>((resolve) => {
    stopped = resolve
  })
  runtime.createManagedWorktree.mockImplementationOnce(
    async (args: {
      onCreateCandidate?: (candidate: { worktreePath: string; branchName: string }) => Promise<void>
      onWorktreeCreated?: (worktreeId: string) => Promise<void>
    }) => {
      await args.onCreateCandidate?.({ worktreePath: WORKTREE_PATH, branchName: 'task' })
      if (reached === 'created') {
        await args.onWorktreeCreated?.(`repo-1::${WORKTREE_PATH}`)
      }
      stopped()
      return new Promise(() => {})
    }
  )
  void launch(runtime, context)
  await stoppedHere
}

/** A new process: the store reread from disk, and nothing in flight. */
async function restartedHost(workspaceExists: boolean): Promise<AgentLaunchRuntimeStub> {
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
  return Object.assign(runtimeStub({ settings: {} }), {
    showManagedWorktree: vi.fn(async (selector: string) => {
      if (!workspaceExists || selector !== `id:repo-1::${WORKTREE_PATH}`) {
        throw new Error('selector_not_found')
      }
      return { id: `repo-1::${WORKTREE_PATH}` }
    })
  })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-create-reconcile-'))
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
})

afterEach(async () => {
  setAgentLaunchRecordStore(null)
  await rm(directory, { recursive: true, force: true })
})

describe('a create-worktree launch whose host stopped mid-create', () => {
  it('names the kept workspace to a caller that reads it when no agent was asked for', async () => {
    await launchThatStopsMidCreate(CLI, 'candidate')

    const runtime = await restartedHost(true)
    await expect(launch(runtime, CLI)).rejects.toMatchObject({
      code: AGENT_LAUNCH_AGENT_NOT_STARTED_CODE,
      data: { worktreeId: `repo-1::${WORKTREE_PATH}` }
    })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('stays uncertain once the workspace was recorded, since an agent may have been asked for', async () => {
    await launchThatStopsMidCreate(CLI, 'created')

    const runtime = await restartedHost(true)
    await expect(launch(runtime, CLI)).rejects.toMatchObject({
      code: 'agent_session_operation_unknown'
    })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('keeps the uncertain answer for a caller that does not read it', async () => {
    await launchThatStopsMidCreate(OLDER_PHONE, 'candidate')

    const runtime = await restartedHost(true)
    await expect(launch(runtime, OLDER_PHONE)).rejects.toMatchObject({
      code: 'agent_session_operation_unknown'
    })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('stays uncertain when the workspace it was about to add never appeared', async () => {
    await launchThatStopsMidCreate(CLI, 'candidate')

    const runtime = await restartedHost(false)
    await expect(launch(runtime, CLI)).rejects.toMatchObject({
      code: 'agent_session_operation_unknown'
    })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })
})
