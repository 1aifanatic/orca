import type { ScriptedAgentChildFactory } from '../runtime/structured-agent-scripted-child.test-fixture'
import type {
  CodexAppServerConnection,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import { CodexAppServerRequestError } from './codex-app-server-connection'
import { codexTurnLifecycleFake } from './codex-turn-lifecycle-fake'

const THREAD = 'scripted-codex-thread'

export const codexScriptedChild: ScriptedAgentChildFactory = () => {
  let holdHandshakes = true
  let completeTurns = true
  let spawned = 0
  let resumed = 0
  let closed = 0
  const prompts: string[] = []
  let newest: ReturnType<typeof Promise.withResolvers<unknown>> | undefined
  const open: typeof openCodexAppServerConnection = async (_launch, handlers = {}) => {
    spawned += 1
    const gate = Promise.withResolvers<unknown>()
    newest = gate
    let ended = false
    const turns = codexTurnLifecycleFake(THREAD, () => (method, params) => {
      if (!ended) {
        handlers.onNotification?.(method, params)
      }
    })
    const connection: CodexAppServerConnection = {
      pid: 10_000 + spawned,
      get closed() {
        return ended
      },
      request: async (method, params) => {
        if (ended) {
          throw new Error('scripted Codex child closed')
        }
        if (method === 'initialize') {
          return holdHandshakes ? gate.promise : {}
        }
        if (method === 'thread/start' || method === 'thread/resume') {
          if (method === 'thread/resume') {
            resumed += 1
          }
          return { thread: { id: THREAD }, model: 'scripted-model' }
        }
        if (method === 'model/list') {
          return {
            data: [{ model: 'scripted-model', isDefault: true, supportedReasoningEfforts: [] }],
            nextCursor: null
          }
        }
        if (method === 'turn/start' || method === 'turn/steer') {
          const input = params?.input
          if (Array.isArray(input)) {
            for (const block of input) {
              if (
                typeof block === 'object' &&
                block !== null &&
                'text' in block &&
                typeof block.text === 'string'
              ) {
                prompts.push(block.text)
              }
            }
          }
          const answer =
            method === 'turn/start'
              ? await turns.routes['turn/start']()
              : turns.routes['turn/steer'](params)
          if (method === 'turn/start') {
            turns.start()
          }
          if (typeof params?.clientUserMessageId === 'string') {
            turns.echo(params.clientUserMessageId)
          }
          if (completeTurns) {
            turns.end('completed')
          }
          return answer
        }
        if (method === 'turn/interrupt') {
          return turns.routes['turn/interrupt'](params)
        }
        return {}
      },
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => {
        if (!ended) {
          ended = true
          closed += 1
          gate.reject(new Error('scripted Codex child closed'))
          handlers.onExit?.(new Error('scripted Codex child closed'), { expected: true })
        }
        return true
      }
    }
    // A gate can be closed before initialization starts or after it has already answered.
    void gate.promise.catch(() => {})
    await handlers.onSpawned?.(connection.pid ?? 0)
    return connection
  }
  return {
    deps: {
      openCodexConnection: open,
      readProcessStartTime: async () => 1_700_000_000_000,
      resolveCodexCommand: () => '/nonexistent/scripted-codex',
      resolveEnvironment: async () => ({})
    },
    get holdHandshakes() {
      return holdHandshakes
    },
    set holdHandshakes(value) {
      holdHandshakes = value
    },
    get completeTurns() {
      return completeTurns
    },
    set completeTurns(value) {
      completeTurns = value
    },
    releaseHandshake: () => newest?.resolve({}),
    failHandshake: (message) =>
      newest?.reject(new CodexAppServerRequestError('initialize', -32603, message, message)),
    prompts: () => prompts,
    spawns: () => spawned,
    resumes: () => resumed,
    closes: () => closed
  }
}
