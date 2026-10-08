import { afterEach, describe, expect, it, vi } from 'vitest'
import { providerDiagnostic, withProviderDiagnostic } from '../../shared/agent-session-failure'
import { AgentSessionAcquisitionExitUnprovenError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import {
  closePiRpcAdapterFixtures,
  file,
  restart,
  reportedEvent,
  sessionId,
  setup,
  state
} from './rpc-session-adapter.test-fixture'

afterEach(closePiRpcAdapterFixtures)

describe('Pi background startup', () => {
  it('publishes at spawn, restores model before effort and reports optional reads after started', async () => {
    const h = await setup()
    const handshake = Promise.withResolvers<unknown>()
    const catalog = Promise.withResolvers<unknown>()
    let revision = 3
    const { acquired, child } = await restart(
      h,
      (connection) => {
        connection.requestOverride = (command) => {
          if (
            command === 'get_state' &&
            !h.lifecycle.mock.calls.some(([event]) => event.type === 'started')
          ) {
            return handshake.promise
          }
          if (command === 'get_available_models') {
            return catalog.promise
          }
          return command === 'set_thinking_level' ? Promise.resolve({}) : undefined
        }
      },
      { options: { effort: 'high', model: 'anthropic/model-2' }, optionRevision: () => revision }
    )
    expect(acquired.link).toBeUndefined()
    expect(child.requests).toEqual(['get_state'])
    expect(h.lifecycle).not.toHaveBeenCalled()
    if (!acquired.acquisitionGeneration) {
      throw new Error('acquisition generation missing')
    }
    expect(h.adapter.holdsLiveProviderProcess(sessionId, acquired.acquisitionGeneration)).toBe(true)
    revision = 5
    handshake.resolve(state)
    await vi.waitFor(() =>
      expect(h.lifecycle).toHaveBeenCalledWith(expect.objectContaining({ type: 'started' }))
    )
    expect(child.requests.slice(0, 3)).toEqual(['get_state', 'set_model', 'set_thinking_level'])
    expect(h.lifecycle.mock.calls[0]?.[0]).toMatchObject({
      type: 'started',
      fence: 8,
      acquisitionGeneration: acquired.acquisitionGeneration,
      link: { handle: { nativeId: file }, origin: 'created' },
      reportedOptions: {
        model: 'anthropic/model-2',
        effort: 'high',
        confirmed: ['model', 'effort']
      },
      restoreSkippedOptions: [],
      optionRevision: 3
    })
    expect(h.lifecycle).toHaveBeenCalledTimes(1)
    revision = 7
    catalog.resolve({ models: [state.model] })
    await vi.waitFor(() => expect(h.lifecycle).toHaveBeenCalledTimes(2))
    expect(h.lifecycle.mock.calls[1]?.[0]).toMatchObject({
      type: 'options-reported',
      optionRevision: 5
    })
  })

  it.each(['closeSession', 'disposeSession', 'forceCloseSession', 'releaseAcquisition'] as const)(
    '%s stops a held handshake without a late started event',
    async (method) => {
      const h = await setup()
      const handshake = Promise.withResolvers<unknown>()
      const { child } = await restart(h, (connection) => {
        connection.requestOverride = (command) =>
          command === 'get_state' ? handshake.promise : undefined
      })
      await (method === 'releaseAcquisition'
        ? h.adapter.releaseAcquisition({ sessionId })
        : h.adapter[method](sessionId))
      handshake.resolve(state)
      await h.adapter.drainObservedExits()
      await Promise.resolve()
      expect(child.rootVerdict).toBe('exited')
      expect(h.lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ended', startupUnproven: true, startupUnanswered: true })
      )
      expect(h.lifecycle).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'started' }))
    }
  )

  it.each([
    ['get_state', new JsonlRpcResponseError('get_state', 'Pi is not signed in'), true],
    ['set_model', new Error('Agent RPC request timed out: set_model'), false],
    ['set_model', new Error('Agent JSON-lines RPC stream closed'), false]
  ] as const)(
    'fails startup on %s failure %s and keeps its diagnostic',
    async (command, error, unanswered) => {
      const h = await setup()
      const { child } = await restart(
        h,
        (connection) => {
          connection.requestOverride = (name) =>
            name === command ? Promise.reject(error) : undefined
        },
        { options: { model: 'anthropic/model-2' } }
      )
      await vi.waitFor(() =>
        expect(h.lifecycle).toHaveBeenCalledWith(expect.objectContaining({ type: 'ended' }))
      )
      expect(child.rootVerdict).toBe('exited')
      const ended = reportedEvent(h.lifecycle, 'ended')
      expect(ended).toMatchObject({
        cause: 'unexpected-exit',
        startupUnproven: true,
        reason: error.message
      })
      expect(ended.startupUnanswered).toBe(unanswered ? true : undefined)
      if (command === 'get_state') {
        expect(ended.failure?.detail).toEqual({ text: 'Pi is not signed in', audience: 'person' })
      }
      expect(h.lifecycle).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'started' }))
    }
  )

  it('does not retry acquisition while a failed start still owns an unproven process', async () => {
    const h = await setup()
    const { child } = await restart(h, (connection) => {
      connection.closeResult = { root: 'unverifiable', tree: null }
      connection.requestOverride = () => Promise.reject(new Error('get_state failed'))
    })
    await vi.waitFor(() => expect(child.closed).toBe(true))
    await expect(h.adapter.acquire({ ...h.input, fence: 9 })).rejects.toBeInstanceOf(
      AgentSessionAcquisitionExitUnprovenError
    )
    expect(h.connections).toHaveLength(2)
    child.closeResult = { root: 'exited', tree: 'exited' }
    await expect(h.adapter.acquire({ ...h.input, fence: 10 })).resolves.toMatchObject({
      process: { pid: 4123 }
    })
  })

  it('preserves the provider exit diagnostic when transport closure failed startup first', async () => {
    const h = await setup()
    await restart(h, (connection) => {
      connection.closeError = withProviderDiagnostic(
        new Error('provider exited'),
        providerDiagnostic('Pi is not signed in', 'log')
      )
      connection.requestOverride = () =>
        Promise.reject(new Error('Agent JSON-lines RPC stream closed'))
    })
    await vi.waitFor(() =>
      expect(h.lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ended',
          startupUnproven: true,
          failure: {
            kind: 'providerStartFailed',
            detail: { text: 'Pi is not signed in', audience: 'log' }
          }
        })
      )
    )
  })

  it('ends a child that exits while its handshake is held', async () => {
    const h = await setup()
    const { child } = await restart(h, (connection) => {
      connection.requestOverride = () => new Promise(() => {})
    })
    child.exit(new Error('provider died during get_state'))
    await h.adapter.drainObservedExits()
    expect(h.lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ended',
        cause: 'unexpected-exit',
        startupUnproven: true,
        startupUnanswered: true,
        reason: 'provider died during get_state'
      })
    )
    expect(h.lifecycle).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'started' }))
  })

  it('rejects an invalid session file and reports a proved resumed file from the launch', async () => {
    const h = await setup()
    const { child } = await restart(h, (connection) => {
      connection.requestOverride = (name) =>
        name === 'get_state'
          ? Promise.resolve({ ...state, sessionFile: 'relative.jsonl' })
          : undefined
    })
    await vi.waitFor(() =>
      expect(h.lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ended', startupUnproven: true })
      )
    )
    expect(child.rootVerdict).toBe('exited')
    const launch = await h.resolveLaunch.mock.results[0]?.value
    if (!launch) {
      throw new Error('launch missing')
    }
    h.resolveLaunch.mockResolvedValueOnce({
      ...launch,
      sessionFile: file,
      previous: h.started.link
    })
    await restart(h, () => {})
    await vi.waitFor(() =>
      expect(h.lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'started',
          link: expect.objectContaining({ origin: 'resumed' })
        })
      )
    )
    expect(h.openConnection.mock.calls.at(-1)?.[0].args).toEqual(
      expect.arrayContaining(['--session', file])
    )
    expect(reportedEvent(h.lifecycle, 'started').link?.handle.nativeId).toBe(file)
  })
})
