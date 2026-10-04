// A scripted ACP agent behind the real adapter: a fake child over in-memory stdio, the real
// protocol runtime, translator and assembler, and a real on-disk journal to read back.

import { vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  openProviderTimelineRig,
  SESSION,
  type ProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { AcpScriptedAgent, tick, type FakeFrame } from './acp-scripted-agent.test-support'
import type { AcpStructuredChild } from './acp-structured-child'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import { AcpStructuredSessionAdapter } from './acp-structured-session-adapter'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

export const GROK = acpLaunchSpecFor('grok')!
export const PROVIDER_SESSION = 'acp-session-1'
export const PID = 4242

export const GROK_CONFIG_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'grok-4.7',
    options: [
      { value: 'grok-4.7', name: 'Grok 4.7' },
      { value: 'grok-4.6', name: 'Grok 4.6' }
    ]
  },
  {
    id: 'reasoning_effort',
    name: 'Reasoning Effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'high', name: 'High' },
      { value: 'low', name: 'Low' }
    ]
  }
]

export class FakeAcpChild implements AcpStructuredChild {
  readonly agent = new AcpScriptedAgent()
  readonly pid: number | undefined = PID
  readonly spawned = Promise.resolve()
  stderr = ''
  private listeners: (() => void)[] = []
  private gone = false
  closes = 0

  constructor(readonly launch: ProviderProcessLaunch) {}

  get stdout() {
    return this.agent.stdout
  }
  get stdin() {
    return this.agent.stdin
  }
  get exited() {
    return this.gone
  }
  onExit(listener: () => void): void {
    if (this.gone) {
      listener()
    } else {
      this.listeners.push(listener)
    }
  }
  stderrTail(): string {
    return this.stderr
  }
  async close(): Promise<boolean> {
    this.closes += 1
    this.exit()
    return true
  }
  /** The agent process ends on its own. */
  exit(): void {
    if (this.gone) {
      return
    }
    this.gone = true
    for (const listener of this.listeners.splice(0)) {
      listener()
    }
  }
}

export type AcpAdapterRig = {
  rig: ProviderTimelineRig
  adapter: AcpStructuredSessionAdapter
  child: () => FakeAcpChild
  spawned: string[]
  lifecycle: StructuredAgentSessionLifecycleEvent[]
  settled: Parameters<NonNullable<AcpStructuredSessionAdapterDeps['onDispatchSettledLate']>>[0][]
  acquire(options?: {
    fence?: number
    onSpawned?: () => Promise<void>
  }): ReturnType<AcpStructuredSessionAdapter['acquire']>
  /** Frames Orca wrote to the agent with this method. */
  sent(method: string): FakeFrame[]
  /** Waits for the `index`th frame Orca writes with this method. */
  frame(method: string, index?: number): Promise<FakeFrame>
  settle(): Promise<void>
}

export async function openAcpAdapterRig(
  options: {
    launch?: Partial<AcpStructuredLaunch>
    initialize?: Record<string, unknown>
    script?: (agent: AcpScriptedAgent) => void
    deps?: Partial<AcpStructuredSessionAdapterDeps>
  } = {}
): Promise<AcpAdapterRig> {
  const rig = await openProviderTimelineRig()
  let current: FakeAcpChild | null = null
  const spawned: string[] = []
  const lifecycle: StructuredAgentSessionLifecycleEvent[] = []
  const settled: AcpAdapterRig['settled'] = []
  const adapter = new AcpStructuredSessionAdapter({
    spec: GROK,
    resolveLaunch: async () => ({
      spec: GROK,
      command: '/opt/grok/bin/grok',
      args: GROK.args({ fullAccess: false }),
      cwd: '/workspace/project',
      env: { PATH: '/usr/bin', ORCA_PANE_KEY: 'tab-1:pane-1', ORCA_AGENT_HOOK_PORT: '1234' },
      fullAccess: false,
      resume: null,
      ...options.launch
    }),
    spawnChild: (launch) => {
      spawned.push('spawn')
      const child = new FakeAcpChild(launch)
      current = child
      const { agent } = child
      agent.on('initialize', (frame) => {
        spawned.push('initialize')
        agent.reply(frame, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          ...options.initialize
        })
      })
      const opened = { sessionId: PROVIDER_SESSION, configOptions: GROK_CONFIG_OPTIONS }
      agent.on('session/new', (frame) => agent.reply(frame, opened))
      agent.on('session/load', (frame) =>
        agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
      )
      options.script?.(agent)
      return child
    },
    readProcessStartTime: async () => 1_700_000_000_000,
    onEvent: (event) => lifecycle.push(event),
    onDispatchSettledLate: (settlement) => settled.push(settlement),
    mintGeneration: () => 'gen-acp',
    now: () => 5_000,
    cancelTimeoutMs: 1_000,
    ...options.deps
  })
  const frames = () => current?.agent.frames ?? []
  return {
    rig,
    adapter,
    child: () => {
      if (!current) {
        throw new Error('no ACP child spawned')
      }
      return current
    },
    spawned,
    lifecycle,
    settled,
    acquire: (acquireOptions = {}) =>
      adapter.acquire({
        identity: {
          sessionId: SESSION,
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'grok',
          providerHandle: null
        },
        fence: acquireOptions.fence ?? 1,
        spawnToken: 'spawn-1',
        events: rig.eventSink,
        onSpawned: async () => {
          spawned.push('onSpawned')
          await acquireOptions.onSpawned?.()
        }
      }),
    sent: (method) => frames().filter((frame) => frame.method === method),
    frame: (method, index = 0) =>
      waitFor(() => {
        const frame = frames().filter((entry) => entry.method === method)[index]
        if (!frame) {
          throw new Error(`no ${method} frame #${index} yet`)
        }
        return frame
      }),
    settle: async () => {
      for (let round = 0; round < 5; round += 1) {
        await tick()
      }
      await rig.rows()
    }
  }
}

const HELLO: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }]
}

/** A person's send of `hello` under `clientMessageId`. */
export function sendHello(rig: AcpAdapterRig, clientMessageId: string, fence = 1) {
  return rig.adapter.dispatch({ sessionId: SESSION, clientMessageId, body: HELLO, fence })
}

/** One streamed reply chunk of the turn Grok runs under `promptId`. */
export function replyChunk(promptId: string, text: string, meta: Record<string, unknown> = {}) {
  return {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    _meta: { promptId, ...meta }
  }
}

export function waitFor<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: 2_000, interval: 5 })
}
