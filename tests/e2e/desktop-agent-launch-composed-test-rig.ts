import type { Mock } from 'vitest'
import type { AgentSessionRecordStore } from '../../src/main/runtime/agent-session-record-store'
import type { createTestStore } from '../../src/renderer/src/store/slices/store-test-helpers'
import type { DesktopNewTabPrompt } from '../../src/shared/desktop-new-tab-prompt'
import type { AgentLaunchPaneVerdict } from '../../src/shared/agent-launch-pane-verdict'
import { RuntimeRpcCallError } from '../../src/renderer/src/runtime/runtime-rpc-result'
import { mapRuntimeError } from '../../src/main/runtime/rpc/errors'
import {
  methodNamed,
  rpcContext,
  runtimeStub
} from '../../src/main/runtime/rpc/methods/agent-launch.test-fixture'
import { DESKTOP_RPC_CALLER } from '../../src/main/runtime/rpc/rpc-caller-identity'
import {
  AGENT_LAUNCH_DESKTOP_NEW_TAB_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY
} from '../../src/shared/agent-launch-runtime-capability'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import { resolveAgentLaunchPaneVerdict } from '../../src/main/agent-launch/agent-launch-pane-attachment'
import { AGENT_LAUNCH_METHODS } from '../../src/main/runtime/rpc/methods/agent-launch'
import { launchAgentThroughHost } from '../../src/renderer/src/lib/agent-launch-through-host'
import { launchNewTabPromptThroughHost } from '../../src/renderer/src/lib/launch-agent-new-tab-host-route'
import { publishAgentLaunchTab } from '../../src/renderer/src/lib/agent-launch-tab-publication'
import { applyAgentLaunchPaneVerdict } from '../../src/renderer/src/lib/agent-launch-pane-verdict-application'

const REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')
const WT = 'wt-7'
const OTHER = 'wt-other'

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export function createDesktopAgentLaunchRig(
  harness: {
    store: ReturnType<typeof createTestStore>
    record: AgentSessionRecordStore
    prompt: DesktopNewTabPrompt
    callRuntimeRpc: Mock<
      (target: unknown, method: string, params: Record<string, unknown>) => Promise<unknown>
    >
  },
  options: {
    selectOther?: boolean
    failure?: 'before' | 'after'
    deferWorkspace?: boolean
    activate?: boolean
    canPublish?: boolean
    workspaceError?: boolean
    rootCwd?: boolean
    structuredAi?: boolean
  } = {}
) {
  const { store, record, prompt, callRuntimeRpc } = harness
  const start = deferred<void>()
  const creating = deferred<void>()
  const admitted = deferred<void>()
  const admission = deferred<void>()
  const workspaceRequested = deferred<void>()
  const workspace = deferred<void>()
  const mount: {
    verdict: AgentLaunchPaneVerdict | null
    shellStarts: number
    attachments: number
  } = {
    verdict: null,
    shellStarts: 0,
    attachments: 0
  }
  const requests: Record<string, unknown>[] = []
  const verdicts: AgentLaunchPaneVerdict[] = []
  const runtime = runtimeStub({
    settings: {},
    publishAgentLaunchTab: async (request) => {
      const answer = publishAgentLaunchTab({ ...request, requestId: 'composed-publication' })
      const waiting = resolveAgentLaunchPaneVerdict(
        { worktreeId: request.worktreeId, paneKey: `${request.tabId}:${request.leafId}` },
        {
          isPaneLive: (key) => runtime.hasLiveTerminalForPaneKey(key),
          openedRows: () => record.listOperationRows(),
          launchPaneOnTab: () =>
            store.getState().tabsByWorktree[WT]?.find((tab) => tab.id === request.tabId)
              ?.agentLaunchPane ?? null,
          openRows: async () => record.listOperationRows(),
          now: () => Date.now()
        }
      )
      if (!waiting) {
        throw new Error('unowned pane at mount')
      }
      void waiting.then((verdict) => {
        mount.verdict = verdict
        applyAgentLaunchPaneVerdict({ ...request, verdict })
        if (verdict.kind === 'proceed') {
          if (runtime.hasLiveTerminalForPaneKey(`${request.tabId}:${request.leafId}`)) {
            mount.attachments += 1
          } else {
            mount.shellStarts += 1
          }
        }
      })
      return answer
    }
  })
  const context = rpcContext(runtime, {
    caller: DESKTOP_RPC_CALLER,
    clientKind: 'runtime',
    clientCapabilities: [
      AGENT_LAUNCH_RUNTIME_CAPABILITY,
      AGENT_LAUNCH_DESKTOP_NEW_TAB_RUNTIME_CAPABILITY,
      AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY
    ]
  })
  const open = runtime.openAgentSessionRecordStore.getMockImplementation()!
  if (options.deferWorkspace) {
    const resolveWorkspace = runtime.showTerminalWorkspaceLaunchScope.getMockImplementation()!
    let lookups = 0
    runtime.showTerminalWorkspaceLaunchScope.mockImplementation(async (selector) => {
      lookups += 1
      if (lookups === (options.structuredAi ? 2 : 1)) {
        workspaceRequested.resolve()
        await workspace.promise
        if (options.workspaceError) {
          throw new Error('workspace_unavailable')
        }
      }
      return resolveWorkspace(selector)
    })
  }
  if (options.canPublish === false) {
    runtime.canPublishAgentLaunchTab.mockReturnValue(false)
  }
  runtime.openAgentSessionRecordStore.mockImplementation(async () => {
    admitted.resolve()
    await admission.promise
    return open()
  })
  let livePane: string | null = null
  runtime.hasLiveTerminalForPaneKey.mockImplementation((key) => livePane === key)
  runtime.getTerminalHandleForPaneKey.mockImplementation((key) =>
    livePane === key ? 'term_1' : null
  )
  runtime.createTerminal.mockImplementation(async (_selector, createOptions) => {
    creating.resolve()
    await start.promise
    if (options.failure === 'after' && typeof createOptions?.onPtySpawnDispatched === 'function') {
      createOptions.onPtySpawnDispatched()
    }
    if (options.failure) {
      throw new Error('spawn_failed')
    }
    if (typeof createOptions?.onPtySpawnDispatched === 'function') {
      createOptions.onPtySpawnDispatched()
    }
    const tabId = createOptions?.tabId
    const leafId = createOptions?.leafId
    if (typeof tabId !== 'string' || typeof leafId !== 'string') {
      throw new Error('missing reserved pane')
    }
    livePane = makePaneKey(tabId, leafId)
    return { handle: 'term_1', paneKey: livePane }
  })
  runtime.closeTerminal.mockImplementation(async () => {
    livePane = null
    return {}
  })
  runtime.reportAgentLaunchPaneVerdict.mockImplementation((pane, verdict) => {
    applyAgentLaunchPaneVerdict({ ...pane, verdict })
    verdicts.push(verdict)
  })
  callRuntimeRpc.mockImplementation(async (_target, method, params) => {
    requests.push(params)
    if (method !== 'agent.launchReplay') {
      throw new Error(`unexpected desktop method ${method}`)
    }
    try {
      return await REPLAY.handler(REPLAY.params.parse(params), context)
    } catch (error) {
      throw new RuntimeRpcCallError(
        mapRuntimeError('desktop-composed', { runtimeId: 'composed-runtime' }, error)
      )
    }
  })
  if (options.selectOther) {
    store.getState().createTab(OTHER)
    store.getState().setActiveWorktree(OTHER)
  }
  const selected = store.getState().activeTabId
  const groupId = store.getState().groupsByWorktree[WT]![0]!.id
  const launchArgs = {
    agent: 'claude',
    worktreeId: WT,
    groupId,
    prompt: prompt.text,
    hostPrompt: prompt.text,
    ...(options.structuredAi ? {} : { desktopPrompt: prompt }),
    activate: options.activate ?? false,
    agentArgs: null,
    cwd: options.rootCwd ? '/tmp/wt-7' : '/tmp/wt-7/src',
    sessionOptions: options.structuredAi ? { model: 'chosen' } : { model: 'chosen', thinking: true }
  } as const
  const launch = () => launchAgentThroughHost(launchArgs)
  const launchPrompt = () =>
    launchNewTabPromptThroughHost({ ...launchArgs, pasteContent: prompt.text })
  return {
    runtime,
    context,
    mount,
    verdicts,
    requests,
    selected,
    groupId,
    launch,
    launchPrompt,
    workspaceRequested,
    workspace,
    start,
    creating,
    admitted,
    admission
  }
}
