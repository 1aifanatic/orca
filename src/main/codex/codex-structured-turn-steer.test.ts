// A send made while a Codex turn runs goes in as `turn/steer` naming that turn, so the
// send is bound to the turn that carries it and that turn's end can settle it. A steer
// Codex refuses took no input, so the send falls back to `turn/start`.

import { describe, expect, it } from 'vitest'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import {
  CodexAppServerTimeoutError,
  CodexAppServerUnsupportedError
} from './codex-app-server-session'
import {
  acquiredCodexAdapter,
  echoUserMessage,
  fakeCodexAppServer,
  startTurn,
  CODEX_TEST_THREAD_ID,
  CODEX_TEST_USER_MESSAGE,
  type CodexTestRoute,
  type LateSettlement
} from './codex-structured-dispatch-test-support'

async function rig(routes: Record<string, CodexTestRoute>) {
  const codex = fakeCodexAppServer(routes)
  const settlements: LateSettlement[] = []
  const adapter = await acquiredCodexAdapter({ codex, settlements })
  const connection = codex.connections[0]!
  const send = (clientMessageId: string) =>
    adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId,
      body: CODEX_TEST_USER_MESSAGE,
      fence: 7
    })
  const methods = () => connection.calls.map(({ method }) => method)
  const endTurn = (turnId: string, status: 'completed' | 'interrupted') =>
    connection.handlers.onNotification?.('turn/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: turnId, status }
    })
  return { connection, settlements, send, methods, endTurn }
}

const refusedSteer = (message: string): CodexAppServerRequestError =>
  new CodexAppServerRequestError(
    'turn/steer',
    -32600,
    `codex app-server turn/steer failed: ${message}`,
    message
  )

describe('a Codex send while a turn runs', () => {
  it('steers into that turn by name, and that turn ending unechoed withdraws it', async () => {
    const { connection, settlements, send, methods, endTurn } = await rig({
      'turn/steer': () => ({ turnId: 'turn-1' }),
      // A Codex before 0.148 answers a steered start with a turn that never opens.
      'turn/start': () => ({ turn: { id: 'submission-7' } })
    })
    startTurn(connection, 'turn-1')

    expect(await send('client-1')).toEqual({ state: 'admitted' })
    expect(methods()).toEqual(['thread/start', 'turn/steer'])
    expect(connection.calls.at(-1)?.params).toEqual({
      threadId: CODEX_TEST_THREAD_ID,
      expectedTurnId: 'turn-1',
      clientUserMessageId: 'client-1',
      input: [{ type: 'text', text: 'ship it' }]
    })

    endTurn('turn-1', 'interrupted')

    expect(settlements).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        state: 'rejected',
        rejection: { kind: 'cancelled' }
      })
    ])
  })

  it('settles on its echo when the turn completes with it', async () => {
    const { connection, settlements, send, endTurn } = await rig({
      'turn/steer': () => ({ turnId: 'turn-1' })
    })
    startTurn(connection, 'turn-1')

    expect(await send('client-1')).toEqual({ state: 'admitted' })
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })
    endTurn('turn-1', 'completed')

    expect(settlements).toEqual([
      expect.objectContaining({
        clientMessageId: 'client-1',
        providerIdentity: expect.objectContaining({ turnId: 'turn-1' })
      })
    ])
  })

  it.each([
    ['the turn ended first', () => refusedSteer('no active turn to steer')],
    [
      'another turn is running',
      () => refusedSteer('expected active turn id `turn-1` but found `turn-2`')
    ],
    ['this Codex has no turn/steer', () => new CodexAppServerUnsupportedError('method not found')]
  ])('falls back to turn/start when Codex refuses the steer because %s', async (_case, error) => {
    const { connection, send, methods } = await rig({
      'turn/steer': () => {
        throw error()
      },
      'turn/start': () => ({ turn: { id: 'turn-2' } })
    })
    startTurn(connection, 'turn-1')

    expect(await send('client-1')).toEqual({ state: 'admitted' })
    expect(methods()).toEqual(['thread/start', 'turn/steer', 'turn/start'])
    expect(connection.calls.at(-1)?.params).toMatchObject({ clientUserMessageId: 'client-1' })
  })

  it('never re-sends a steer that may have landed, and keeps it armed for its echo', async () => {
    const { connection, settlements, send, methods } = await rig({
      'turn/steer': () => {
        throw new CodexAppServerTimeoutError('codex app-server turn/steer exceeded 100ms')
      }
    })
    startTurn(connection, 'turn-1')

    await expect(send('client-1')).rejects.toThrow('turn/steer exceeded')
    expect(methods()).toEqual(['thread/start', 'turn/steer'])
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })

    expect(settlements).toEqual([expect.objectContaining({ clientMessageId: 'client-1' })])
  })

  it('starts a turn with no steer when none is running', async () => {
    const { send, methods, endTurn, connection } = await rig({
      'turn/start': () => ({ turn: { id: 'turn-1' } })
    })
    startTurn(connection, 'turn-0')
    endTurn('turn-0', 'completed')

    expect(await send('client-1')).toEqual({ state: 'admitted' })
    expect(methods()).toEqual(['thread/start', 'turn/start'])
  })
})
