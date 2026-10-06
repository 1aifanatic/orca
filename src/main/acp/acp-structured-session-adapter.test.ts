import { afterEach, describe, expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionRefusal,
  AgentSessionAcquisitionRootExitObservedError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { ACP_CHILD_ENV_TO_DELETE } from './acp-launch-specs'
import { AGENT_HOOK_RUNTIME_ENV_KEYS } from '../ipc/pty/host-env/spawn-env-keys'
import {
  GROK,
  openAcpAdapterRig,
  PID,
  PROVIDER_SESSION,
  waitFor,
  type AcpAdapterRig
} from './acp-structured-adapter.test-support'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const hello: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }]
}

function send(rig: AcpAdapterRig, clientMessageId: string) {
  return rig.adapter.dispatch({ sessionId: SESSION, clientMessageId, body: hello, fence: 1 })
}

function chunk(promptId: string, text: string) {
  return {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    _meta: { promptId }
  }
}

describe('ACP structured session adapter: acquire', () => {
  it('records the child before the handshake and starts a new session with client fs and terminals off', async () => {
    const rig = await openAcpAdapterRig()
    const acquired = await rig.acquire()
    expect(rig.spawned).toEqual(['spawn', 'onSpawned', 'initialize'])
    expect(acquired.process).toMatchObject({ pid: PID, spawnToken: 'spawn-1', hostId: 'local' })
    expect(acquired.link).toMatchObject({
      handle: { transport: 'acp', agent: 'grok', nativeId: PROVIDER_SESSION },
      origin: 'created',
      mintedAtFence: 1
    })
    expect(rig.sent('initialize')[0]?.params).toMatchObject({
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
    })
    expect(rig.sent('session/new')[0]?.params).toEqual({
      cwd: '/workspace/project',
      mcpServers: []
    })
  })

  it('launches without any pane identity, so the agent own status hooks stay silent', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    const launch = rig.child().launch
    expect(launch.envToDelete).toEqual(expect.arrayContaining([...ACP_CHILD_ENV_TO_DELETE]))
    expect(launch.envToDelete).toEqual(
      expect.arrayContaining(['ORCA_PANE_KEY', 'ORCA_AGENT_PANE', ...AGENT_HOOK_RUNTIME_ENV_KEYS])
    )
    expect(launch.env).toMatchObject({
      ORCA_AGENT_SESSION_ID: SESSION,
      ORCA_AGENT_SESSION_SPAWN_TOKEN: 'spawn-1'
    })
  })

  it('replaces a created session the agent never saved with a new one', async () => {
    const rig = await openAcpAdapterRig({
      launch: { resume: { sessionId: 'lost', key: 'old-key', mayBeUnsaved: true } },
      script: (agent) =>
        agent.on('session/load', (frame) => agent.fail(frame, -32002, 'Session not found'))
    })
    const acquired = await rig.acquire({ fence: 2 })
    expect(acquired.link).toMatchObject({ origin: 'created', supersedesKey: 'old-key' })
  })

  it('refuses a signed-out agent through the existing start-failure surface and stops its child', async () => {
    const rig = await openAcpAdapterRig({
      script: (agent) =>
        agent.on('session/new', (frame) => agent.fail(frame, -32000, 'Authentication required'))
    })
    const failure = await rig.acquire().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AgentSessionAcquisitionRefusal)
    expect(failure).toMatchObject({ reason: 'notSignedIn' })
    expect(rig.child().closes).toBe(1)
  })
})

it('reports an agent that exits while starting with its own last words', async () => {
  const rig = await openAcpAdapterRig({
    script: (agent) =>
      agent.on('session/new', () => {
        const child = rig.child()
        child.stderr = 'grok: config.toml is invalid'
        child.exit()
      })
  })
  const failure = await rig.acquire().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AgentSessionAcquisitionExitProvenError)
  expect(failure).toMatchObject({ message: 'grok: config.toml is invalid' })
  expect(rig.lifecycle).toEqual([])
})

it('reads those last words when the agent ends its stdout before its exit is seen', async () => {
  const rig = await openAcpAdapterRig({
    script: (agent) =>
      agent.on('session/new', () => {
        const child = rig.child()
        child.stderr = 'grok: config.toml is invalid'
        // On POSIX a dying process's stdout ends first; its exit is observed a moment later.
        child.agent.stdout.end()
        setTimeout(() => child.exit(), 5)
      })
  })
  const failure = await rig.acquire().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AgentSessionAcquisitionExitProvenError)
  expect(failure).toMatchObject({ message: 'grok: config.toml is invalid' })
})

describe('ACP structured session adapter: turns', () => {
  it('sends a prompt under an injected id and settles it on the agent first event', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    expect(await send(rig, 'send-1')).toEqual({ state: 'admitted' })
    const prompt = await rig.frame('session/prompt')
    expect(prompt.params).toMatchObject({
      prompt: [{ type: 'text', text: 'hello' }],
      _meta: { promptId: 'prompt:send-1', requestId: 'prompt:send-1' }
    })
    rig.child().agent.notify('session/update', chunk('prompt:send-1', 'Hi there'))
    await waitFor(() =>
      expect(rig.settled).toEqual([
        {
          sessionId: SESSION,
          clientMessageId: 'send-1',
          providerIdentity: { provider: 'orca', clientMessageId: 'send-1' }
        }
      ])
    )
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await waitFor(async () => {
      const turns = (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
      expect(turns.at(-1)).toMatchObject({ state: 'completed', outcome: 'success' })
    })
  })

  it('stops a running turn: open permissions answer cancelled, session/cancel goes out', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await send(rig, 'send-1')
    const prompt = await rig.frame('session/prompt')
    const { agent } = rig.child()
    const permission = agent.request(7, 'session/request_permission', {
      sessionId: PROVIDER_SESSION,
      toolCall: { toolCallId: 'call-1', title: 'Write file' },
      options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
    })
    agent.on('session/cancel', () => agent.reply(prompt, { stopReason: 'cancelled' }))
    await rig.settle()
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: true
    })
    expect(await permission).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    expect(rig.sent('session/cancel')).toHaveLength(1)
    await waitFor(async () => {
      const turns = (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
      expect(turns.at(-1)).toMatchObject({ state: 'interrupted' })
    })
  })

  it('answers a Stop with no turn running as one the agent was not running', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: false,
      refusal: { turnNotRunning: true }
    })
  })
})

describe('ACP structured session adapter: approvals', () => {
  it('commits the journal answer before replying with the option the person chose', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await send(rig, 'send-1')
    await rig.frame('session/prompt')
    const { agent } = rig.child()
    const reply = agent.request(3, 'session/request_permission', {
      sessionId: PROVIDER_SESSION,
      toolCall: { toolCallId: 'call-1', title: 'Write file' },
      options: [
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
      ]
    })
    const row = await waitFor(async () => {
      const found = (await rig.rig.rows()).find((item) => item.body.kind === 'approval')
      expect(found).toBeDefined()
      return found!
    })
    const order: string[] = []
    let answered = false
    void reply.then(() => {
      answered = true
      order.push('reply')
    })
    await rig.adapter.answerPrompt({
      sessionId: SESSION,
      itemId: row.itemId,
      kind: 'approval',
      response: { kind: 'option', optionId: 'reject-once' },
      fence: 1,
      commit: async () => {
        order.push('commit')
        expect(answered).toBe(false)
      }
    })
    expect(await reply).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'reject-once' } }
    })
    expect(order).toEqual(['commit', 'reply'])
    await expect(
      rig.adapter.answerPrompt({
        sessionId: SESSION,
        itemId: row.itemId,
        kind: 'approval',
        response: { kind: 'option', optionId: 'allow-once' },
        fence: 1,
        commit: async () => {}
      })
    ).rejects.toThrow(/no longer waiting/)
  })

  it('answers cancelled a permission Grok asks during a turn it began itself, with no card', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    const { agent } = rig.child()
    agent.notify('session/update', chunk('task-completed-background-1', 'Build finished; now'))
    await rig.settle()
    const reply = await agent.request(3, 'session/request_permission', {
      sessionId: PROVIDER_SESSION,
      toolCall: { toolCallId: 'call-1', title: 'Write file' },
      options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
    })
    expect(reply).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    expect((await rig.rig.rows()).some((row) => row.body.kind === 'approval')).toBe(false)
  })
})

describe('ACP structured session adapter: requests a Stop cancels', () => {
  it("answers an open plan approval with Grok's own cancelled reply once a Stop cancels it", async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await send(rig, 'send-1')
    const prompt = await rig.frame('session/prompt')
    const { agent } = rig.child()
    const plan = agent.request(5, '_x.ai/exit_plan_mode', {
      sessionId: PROVIDER_SESSION,
      toolCallId: 'call-2',
      planContent: '# Plan'
    })
    await waitFor(async () => {
      expect((await rig.rig.rows()).some((row) => row.body.kind === 'approval')).toBe(true)
    })
    agent.on('session/cancel', () => agent.reply(prompt, { stopReason: 'cancelled' }))
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: true
    })
    expect(await plan).toMatchObject({ result: { outcome: 'abandoned' } })
    expect(agent.frames.filter((frame) => frame.id === 5)).toHaveLength(1)
  })

  it('reports a permission answer whose save outlived the Stop as unconfirmed, not given', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await send(rig, 'send-1')
    const prompt = await rig.frame('session/prompt')
    const { agent } = rig.child()
    const permission = agent.request(6, 'session/request_permission', {
      sessionId: PROVIDER_SESSION,
      toolCall: { toolCallId: 'call-1', title: 'Write file' },
      options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
    })
    const row = await waitFor(async () => {
      const found = (await rig.rig.rows()).find((item) => item.body.kind === 'approval')
      expect(found).toBeDefined()
      return found!
    })
    agent.on('session/cancel', () => agent.reply(prompt, { stopReason: 'cancelled' }))
    const answering = rig.adapter.answerPrompt({
      sessionId: SESSION,
      itemId: row.itemId,
      kind: 'approval',
      response: { kind: 'option', optionId: 'allow-once' },
      fence: 1,
      // The Stop lands while the person's answer is being saved.
      commit: () => rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 }).then(() => {})
    })
    await expect(answering).rejects.toThrow(/stopped waiting/)
    expect(await permission).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
  })
})

describe('ACP structured session adapter: options and commands', () => {
  it('reads the agent own models and effort and writes a pick through set_config_option', async () => {
    const rig = await openAcpAdapterRig({
      script: (agent) =>
        agent.on('session/set_config_option', (frame) => agent.reply(frame, { configOptions: [] }))
    })
    await rig.acquire()
    const options = await rig.adapter.readOptions({ sessionId: SESSION, fence: 1 })
    expect(options.current).toMatchObject({ model: 'grok-4.7', effort: 'high' })
    expect(options.models.map((model) => model.id)).toEqual(['grok-4.7', 'grok-4.6'])
    expect(options.models[0]?.efforts.map((effort) => effort.value)).toEqual(['high', 'low'])
    await rig.adapter.setOption({ sessionId: SESSION, key: 'model', value: 'grok-4.6', fence: 1 })
    expect(rig.sent('session/set_config_option')[0]?.params).toMatchObject({
      configId: 'model',
      value: 'grok-4.6'
    })
    await expect(
      rig.adapter.setOption({ sessionId: SESSION, key: 'fastMode', value: 'true', fence: 1 })
    ).rejects.toThrow(/no session option/)
  })

  it('reports the agent own slash commands', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    expect(rig.adapter.readCommands(SESSION)).toBeUndefined()
    rig.child().agent.notify('session/update', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'compact', description: 'Compress history', input: null },
          { name: 'always-approve', description: 'Toggle', input: { hint: 'on|off' } }
        ]
      }
    })
    await waitFor(() =>
      expect(rig.adapter.readCommands(SESSION)).toEqual([
        { name: 'compact', kind: 'command', description: 'Compress history' },
        { name: 'always-approve', kind: 'command', description: 'Toggle', argumentHint: 'on|off' }
      ])
    )
  })
})

describe('ACP structured session adapter: close and exit', () => {
  it('reports a close whose root exited but whose process tree was not proven gone', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    rig.child().treeUnproven = true
    await expect(rig.adapter.closeSession(SESSION)).rejects.toBeInstanceOf(
      AgentSessionAcquisitionRootExitObservedError
    )
    expect(rig.lifecycle).toMatchObject([{ type: 'ended', cause: 'requested-close' }])
  })

  it('closes with proof and reports a requested close', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await expect(rig.adapter.closeSession(SESSION)).resolves.toBe(true)
    expect(rig.lifecycle).toMatchObject([
      { type: 'ended', sessionId: SESSION, cause: 'requested-close', fence: 1 }
    ])
    await expect(rig.adapter.closeSession(SESSION)).resolves.toBe(true)
    expect(rig.lifecycle).toHaveLength(1)
  })

  it('ends the session on an unexpected exit: held sends rejected, the running one unknown', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await send(rig, 'send-1')
    await rig.frame('session/prompt')
    await send(rig, 'send-2')
    rig.child().stderr = 'grok: crashed'
    rig.child().exit()
    await waitFor(() =>
      expect(rig.lifecycle).toMatchObject([
        {
          type: 'ended',
          cause: 'unexpected-exit',
          acquisitionGeneration: 'gen-acp',
          failure: { kind: 'providerExited' }
        }
      ])
    )
    expect(rig.settled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientMessageId: 'send-2', state: 'rejected' }),
        expect.objectContaining({ clientMessageId: 'send-1', state: 'unknown' })
      ])
    )
    await expect(send(rig, 'send-3')).rejects.toThrow(/no live grok child/)
  })
})

describe('Grok launch spec', () => {
  it('runs `grok agent stdio`, asking for always-approve only with full access', () => {
    expect(GROK.args({ fullAccess: false })).toEqual(['agent', 'stdio'])
    expect(GROK.args({ fullAccess: true })).toEqual(['agent', '--always-approve', 'stdio'])
    expect(GROK.env).toEqual({})
  })
})
