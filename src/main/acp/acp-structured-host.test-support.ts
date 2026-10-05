// The ACP adapter behind the real host, with a scripted Grok, the real record store and an
// on-disk journal.

import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { agentSessionStoredAgents } from '../../shared/agent-session-stored-agent'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { messageText } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import {
  hostTestState,
  replaceHostTestState
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { AgentSessionRecoveryCapsule } from '../runtime/agent-session-recovery-capsule'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session-record-store-test-harness'
import type { AcpScriptedAgent } from './acp-scripted-agent.test-support'
import {
  GROK,
  openAcpAdapterRig,
  PROVIDER_SESSION,
  replyChunk
} from './acp-structured-adapter.test-support'
import { acpStructuredAgentDefinition } from './acp-structured-agent-definitions'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

export const hello: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }]
}

export const attachParams = (fence: number | null = null) =>
  hostTestAttachParams(fence, {
    provider: 'grok',
    agent: 'grok',
    accountHome: { variable: 'GROK_HOME', path: '/grok' },
    providerHandle: undefined
  })

/** A launch that resumes the provider session once the chat has one. */
export function launch(resume: () => boolean): () => Promise<AcpStructuredLaunch> {
  return async () => ({
    spec: GROK,
    command: '/fake/grok',
    args: [],
    cwd: '/workspace',
    env: {},
    fullAccess: false,
    resume: resume() ? { sessionId: PROVIDER_SESSION, replaceableKey: null } : null
  })
}

export async function openHostRig(
  options: {
    script?: (agent: AcpScriptedAgent) => void
    initialize?: Record<string, unknown>
    deps?: Partial<AcpStructuredSessionAdapterDeps>
  } = {}
) {
  const state = hostTestState()
  const store = await openTestAgentSessionRecordStore(state.root, {
    agents: agentSessionStoredAgents([{ agent: 'grok' }])
  })
  let generation = 0
  // As the runtime wires it: every exit the adapter observes reaches the host.
  const hosted: { host: StructuredAgentSessionHost | null } = { host: null }
  const rig = await openAcpAdapterRig({
    ...options,
    deps: {
      onEvent: (event) => void hosted.host?.handleAdapterEvent(event),
      now: () => HOST_TEST_NOW,
      readProcessStartTime: async () => 1_700_000_000_000 + ++generation,
      mintGeneration: () => `generation-${generation}`,
      ...options.deps
    }
  })
  const host = new StructuredAgentSessionHost({
    agents: new StructuredAgentRegistry([
      { definition: acpStructuredAgentDefinition(GROK), adapter: rig.adapter }
    ]),
    logger: state.log.logger,
    store,
    adapter: rig.adapter,
    journalDatabase: openTestJournalHostDatabase(state.root),
    recoveryCapsule: new AgentSessionRecoveryCapsule(state.root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => HOST_TEST_NOW
  })
  hosted.host = host
  replaceHostTestState({ store, host })
  const fence = () => store.getRecord(SESSION)?.lease.runtimeFence ?? 1
  const messages = async () =>
    (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
      .filter((row) => row.body.kind === 'message')
      .map((row) => messageText(row.body))
  /** Orca's send of `hello` as `m1`, and Grok's reply `text`, ended or left running. */
  const exchange = async (text: string, end: boolean) => {
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    await journal.appendItem({ provider: 'orca', clientMessageId: 'm1' }, hello, {
      fence: fence(),
      turnScope: { kind: 'thread' }
    })
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'm1',
      body: hello,
      fence: fence()
    })
    const prompt = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:m1', text))
    if (end) {
      rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    }
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
  }
  return { rig, host, store, fence, messages, exchange }
}

/** Grok's capabilities: it loads and resumes sessions. */
export const RESUMES = {
  agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }
}
