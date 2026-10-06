// A Grok session Grok cannot reopen, through the real host, record store, journal and launch
// resolver: a fresh session continues the chat, the chain records what it replaced, and the chat
// says so once, unless nothing was ever exchanged on the lost session.

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readAgentSessionFailureFact } from '../../shared/agent-session-failure'
import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleKey
} from '../../shared/agent-session-provider-handle'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { AcpScriptedAgent } from './acp-scripted-agent.test-support'
import { GROK, GROK_CONFIG_OPTIONS, PROVIDER_SESSION } from './acp-structured-adapter.test-support'
import { ACP_HANDLE_TRANSPORT } from './acp-structured-agent-definitions'
import { replayJournal } from '../native-chat/agent-session-journal/journal-open'
import { createAcpStructuredLaunchResolver } from './acp-structured-launch-resolution'
import {
  attachParams,
  openHostRig,
  promptIdOf,
  RESUMES,
  send
} from './acp-structured-host.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const FRESH = 'grok-fresh-session'
const keyOf = (nativeId: string) =>
  agentSessionProviderHandleKey({ transport: ACP_HANDLE_TRANSPORT, agent: 'grok', nativeId })

/** Grok's first session opens, then cannot be reopened with `code`; every session after it reopens. */
function firstSessionLost(loads: string[], code: number, message: string) {
  let opened = 0
  return (agent: AcpScriptedAgent) => {
    agent.on('session/new', (frame) => {
      opened += 1
      agent.reply(frame, {
        sessionId: opened === 1 ? PROVIDER_SESSION : FRESH,
        configOptions: GROK_CONFIG_OPTIONS
      })
    })
    agent.on('session/load', (frame) => {
      const { sessionId } = z.object({ sessionId: z.string() }).parse(frame.params)
      loads.push(sessionId)
      if (sessionId === PROVIDER_SESSION) {
        agent.fail(frame, code, message)
      } else {
        agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
      }
    })
  }
}

async function openRestoreRig(code: number, message: string) {
  const loads: string[] = []
  const resolver: { resolve: ReturnType<typeof createAcpStructuredLaunchResolver> | null } = {
    resolve: null
  }
  const opened = await openHostRig({
    initialize: RESUMES,
    script: firstSessionLost(loads, code, message),
    deps: {
      resolveLaunch: (input) => {
        if (!resolver.resolve) {
          throw new Error('launch resolver not ready')
        }
        return resolver.resolve(input)
      }
    }
  })
  const { rig, host, store, journalDatabase } = opened
  resolver.resolve = createAcpStructuredLaunchResolver(GROK, {
    store,
    readJournal: (sessionId) => replayJournal(journalDatabase.db, sessionId),
    resolveWorkspacePath: async () => '/workspace',
    resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
    resolveCommand: () => '/fake/grok'
  })
  const warnings = async () => {
    await host.flushStreamedEvents(SESSION)
    return (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items.filter(
      (row) =>
        row.body.kind === 'status' &&
        readAgentSessionFailureFact(row.body.failure)?.kind === 'sessionNotRestored'
    )
  }
  /** A send Grok answers in `providerSession`, ending its turn. */
  const exchange = async (text: string, reply: string, providerSession: string) => {
    await send(host, text)
    const prompt = await rig.frame('session/prompt')
    expect(prompt.params).toMatchObject({ sessionId: providerSession })
    rig.child().agent.notify('session/update', {
      sessionId: providerSession,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } },
      _meta: { promptId: promptIdOf(prompt) }
    })
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
  }
  return { ...opened, loads, warnings, exchange }
}

describe('a saved Grok session Grok cannot reopen', () => {
  it('continues the chat in a fresh session that the chain records and the next reopen loads', async () => {
    const { host, store, fence, loads, warnings, exchange } = await openRestoreRig(
      -32603,
      'session file is corrupt'
    )

    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })

    expect(loads).toEqual([PROVIDER_SESSION])
    const chain = store.getRecord(SESSION)?.providerHandleChain ?? []
    expect(chain).toHaveLength(2)
    expect(agentSessionProviderHandleChainHead(chain)).toMatchObject({
      origin: 'created',
      handle: { nativeId: FRESH },
      replaces: { key: keyOf(PROVIDER_SESSION), reason: 'restore-failed' }
    })
    const rows = await warnings()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.body).toMatchObject({
      kind: 'status',
      tone: 'warning',
      text: "Grok couldn't reopen its earlier session, so this chat continues in a new one. Grok doesn't remember the earlier messages."
    })

    // The chat keeps working in the fresh session.
    await exchange('still there?', 'yes', FRESH)
    const messages = (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
      .filter((row) => row.body.kind === 'message')
      .map((row) => (row.body.kind === 'message' ? row.body.blocks : []))
    expect(messages.flat()).toEqual(
      expect.arrayContaining([
        { type: 'text', text: 'still there?' },
        { type: 'text', text: 'yes' }
      ])
    )

    // The next reopen loads the fresh session, and says nothing new.
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    expect(loads).toEqual([PROVIDER_SESSION, FRESH])
    expect(store.getRecord(SESSION)?.providerHandleChain).toHaveLength(3)
    expect(await warnings()).toHaveLength(1)
    await host.close(SESSION, 'user-close')
  })
})

describe('a created Grok session Grok reports missing on the first reopen', () => {
  it('replaces it and says so once when the chat exchanged a turn on it', async () => {
    const { host, store, fence, loads, warnings, exchange, messages } = await openRestoreRig(
      -32002,
      'Resource not found'
    )
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await exchange('remember 42', 'noted', PROVIDER_SESSION)
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })

    expect(loads).toEqual([PROVIDER_SESSION])
    const chain = store.getRecord(SESSION)?.providerHandleChain ?? []
    expect(chain).toHaveLength(2)
    const head = agentSessionProviderHandleChainHead(chain)
    expect(head).toMatchObject({
      origin: 'created',
      handle: { nativeId: FRESH },
      replaces: { key: keyOf(PROVIDER_SESSION), reason: 'restore-failed' }
    })
    expect(head?.supersedesKey).toBeUndefined()
    expect(await warnings()).toHaveLength(1)
    // The person still sees what Grok forgot.
    expect(await messages()).toEqual(expect.arrayContaining(['remember 42', 'noted']))

    // The next reopen loads the fresh session, and says nothing new.
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    expect(loads).toEqual([PROVIDER_SESSION, FRESH])
    expect(await warnings()).toHaveLength(1)
    await host.close(SESSION, 'user-close')
  })

  it('supersedes it silently when nothing was exchanged on it', async () => {
    const { host, store, fence, loads, warnings } = await openRestoreRig(
      -32002,
      'Resource not found'
    )
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })

    expect(loads).toEqual([PROVIDER_SESSION])
    const chain = store.getRecord(SESSION)?.providerHandleChain ?? []
    expect(chain).toHaveLength(1)
    const head = agentSessionProviderHandleChainHead(chain)
    expect(head).toMatchObject({
      origin: 'created',
      handle: { nativeId: FRESH },
      supersedesKey: keyOf(PROVIDER_SESSION)
    })
    expect(head?.replaces).toBeUndefined()
    expect(await warnings()).toEqual([])
    await host.close(SESSION, 'user-close')
  })
})
