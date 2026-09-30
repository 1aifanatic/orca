import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../shared/orchestration-session-caller-codes'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import {
  ADDRESS_X,
  ADDRESS_Y,
  createSessionCallerHarness,
  idOf,
  orchestrationRequest,
  PROVIDER_ID_X,
  resultOf,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

describe('orchestration.callerShow: the caller learns its own address from the host', () => {
  let h: SessionCallerHarness

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  function callerShow(options: Parameters<typeof orchestrationRequest>[2]) {
    return orchestrationRequest('orchestration.callerShow', {}, options)
  }

  it('answers a chat with session:<id>, even in terminal view where it also carries a pane', async () => {
    const response = await h.dispatch(
      callerShow({
        sessionId: SESSION_X,
        evidence: { terminalHandle: 'term_tui', paneKey: 'tab_tui:1:2' }
      })
    )

    expect(resultOf(response)).toEqual({
      caller: { address: ADDRESS_X, live: true }
    })
  })

  it('answers a structured worker with the one address its preamble and its mail show', async () => {
    const handle = mintStructuredWorkerHandle()
    structuredWorkerIdentities.register({
      handle,
      sessionId: SESSION_Y,
      agent: 'claude',
      paneKey: mintStructuredWorkerPaneKey(SESSION_Y),
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    const asX = (method: string, params: Record<string, unknown>) =>
      h.dispatch(orchestrationRequest(method, params, { sessionId: SESSION_X }))
    const runId = idOf(resultOf(await asX('orchestration.runCreate', { objective: 'o' })).run)
    const task = h.db.createTask({ runId, spec: 'work' })

    const shown = resultOf(
      await h.dispatch(callerShow({ sessionId: SESSION_Y, evidence: { terminalHandle: handle } }))
    )
    const { preamble } = resultOf(
      await asX('orchestration.dispatch', { task: task.id, to: ADDRESS_Y, dryRun: true })
    )
    await h.dispatch(
      orchestrationRequest(
        'orchestration.send',
        { to: ADDRESS_X, subject: 'progress', type: 'status' },
        { sessionId: SESSION_Y }
      )
    )
    const checked = resultOf(await asX('orchestration.check', { all: true, format: true }))

    expect(shown).toEqual({ caller: { address: handle, live: true } })
    expect(preamble).toContain(`Your orchestration address is: ${handle}\n`)
    expect(checked.messages).toEqual([expect.objectContaining({ from_handle: handle })])
    expect(checked.formatted).toContain(`(${handle})`)
    expect(JSON.stringify({ preamble, checked })).not.toContain(ADDRESS_Y)
  })

  it('refuses a session that is not running, with the same code every orchestration verb gets', async () => {
    h.records.set(SESSION_X, sessionRecord(SESSION_X, { lease: { claimStatus: 'released' } }))

    const response = await h.dispatch(callerShow({ sessionId: SESSION_X }))

    expect(response).toMatchObject({
      ok: false,
      error: { code: CODES.notLive, message: expect.stringContaining(SESSION_X) }
    })
  })

  it("names the Orca id when handed the provider's id", async () => {
    const response = await h.dispatch(callerShow({ sessionId: PROVIDER_ID_X }))

    expect(response).toMatchObject({
      ok: false,
      error: { code: CODES.providerId, data: { orcaSessionId: SESSION_X } }
    })
  })

  it('refuses a session claim from a paired client, naming the host boundary', async () => {
    const response = await h.dispatchStreaming(callerShow({ sessionId: SESSION_X }), 'paired-1')

    expect(response).toMatchObject({ ok: false, error: { code: CODES.hostBoundary } })
  })

  it('answers a terminal agent with the handle its environment carries, and whether it is live', async () => {
    const probe = vi
      .spyOn(h.runtime, 'resolveTerminalIdentity')
      .mockImplementation((handle) => ({ handle, live: handle === 'term_live' }))

    const live = await h.dispatch(callerShow({ evidence: { terminalHandle: 'term_live' } }))
    const stale = await h.dispatch(callerShow({ evidence: { terminalHandle: 'term_stale' } }))

    expect(resultOf(live)).toEqual({
      caller: { address: 'term_live', live: true }
    })
    expect(resultOf(stale)).toEqual({
      caller: { address: 'term_stale', live: false }
    })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('answers the reminted handle, as the coordinator verbs act, when the carried one went stale', async () => {
    vi.spyOn(h.runtime, 'resolveTerminalIdentity').mockImplementation((handle) => ({
      handle,
      live: handle === 'term_new'
    }))
    const resolvePane = vi.spyOn(h.runtime, 'resolveTerminalPane').mockImplementation((paneKey) => {
      if (paneKey !== 'tab_1:leaf_1') {
        throw new Error('terminal_not_found')
      }
      return { handle: 'term_new', tabId: 'tab_1', leafId: 'leaf_1', ptyId: null, connected: true }
    })

    const reminted = await h.dispatch(
      callerShow({ evidence: { terminalHandle: 'term_old', paneKey: 'tab_1:leaf_1' } })
    )
    const paneOnly = await h.dispatch(callerShow({ evidence: { paneKey: 'tab_1:leaf_1' } }))
    const gone = await h.dispatch(
      callerShow({ evidence: { terminalHandle: 'term_old', paneKey: 'tab_gone:leaf' } })
    )

    expect(resultOf(reminted)).toEqual({
      caller: { address: 'term_new', live: true }
    })
    expect(resultOf(paneOnly)).toEqual({
      caller: { address: 'term_new', live: true }
    })
    expect(resultOf(gone)).toEqual({
      caller: { address: 'term_old', live: false }
    })
    expect(resolvePane).toHaveBeenCalledTimes(3)
  })

  it('gives the menu the exact address each session of a cleared chat acts as', async () => {
    const cleared = sessionRecord(SESSION_X)
    h.records.set(SESSION_X, {
      ...cleared,
      conversationCommand: {
        command: 'clear',
        state: 'completed',
        replacementSessionId: SESSION_Y,
        operationId: 'op',
        callerKey: 'caller',
        phase: 'committed'
      }
    })

    for (const sessionId of [SESSION_X, SESSION_Y]) {
      const shown = resultOf(
        await h.dispatch(orchestrationRequest('orchestration.sessionAddress', { sessionId }))
      )
      const acting = resultOf(await h.dispatch(callerShow({ sessionId })))
      // One derivation: the conversation's root, which the successor copies and acts as too.
      expect(shown.address).toBe(ADDRESS_X)
      expect(acting.caller).toMatchObject({ address: shown.address })
    }
  })

  it('refuses an address for an id that is not an Orca session id', async () => {
    const response = await h.dispatch(
      orchestrationRequest('orchestration.sessionAddress', { sessionId: 'not an id' })
    )

    expect(response).toMatchObject({ ok: false, error: { code: CODES.unknown } })
  })

  it('answers null for a caller whose environment carries no identity', async () => {
    const response = await h.dispatch(callerShow({}))

    expect(resultOf(response)).toEqual({ caller: null })
  })
})
