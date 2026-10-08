// A Grok chat whose saved Arguments or Command can't start, driven through the real launch
// resolver and the ACP start path to the refusal a client receives: named, and before any spawn.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { replayJournal } from '../native-chat/agent-session-journal/journal-open'
import { mapRuntimeError } from '../runtime/rpc/errors'
import { GROK } from './acp-structured-adapter.test-support'
import { createAcpStructuredLaunchResolver } from './acp-structured-launch-resolution'
import { attachParams, openHostRig } from './acp-structured-host.test-support'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
})

async function attachUnder(launch: { launchArgs: string[]; resolveCommand?: () => string }) {
  const resolver: { resolve: ReturnType<typeof createAcpStructuredLaunchResolver> | null } = {
    resolve: null
  }
  const opened = await openHostRig({
    deps: {
      resolveLaunch: (input) => {
        if (!resolver.resolve) {
          throw new Error('launch resolver not ready')
        }
        return resolver.resolve(input)
      }
    }
  })
  resolver.resolve = createAcpStructuredLaunchResolver(GROK, {
    store: opened.store,
    readJournal: (sessionId) => replayJournal(opened.journalDatabase.db, sessionId),
    resolveWorkspacePath: async () => '/workspace',
    resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
    resolveLaunchArgs: () => launch.launchArgs,
    resolveCommand: launch.resolveCommand ?? (() => '/fake/grok')
  })
  const attach = () =>
    opened.host.attach(CALLER, attachParams()).then(
      (result) => result,
      (error: unknown) => error
    )
  return { first: await attach(), replay: await attach(), spawned: opened.rig.spawned }
}

describe('a Grok chat that cannot start under its saved settings', () => {
  it('refuses saved Arguments it cannot honor by name, on the first answer and the replay', async () => {
    const { first, replay, spawned } = await attachUnder({ launchArgs: ['--cwd', '/private'] })
    const sentence =
      "Grok couldn't start. Grok chats can't use --cwd from saved Arguments. Remove it from Grok's Arguments in Settings → Agents. A chat already works in its workspace folder. Send your message to try again."
    for (const result of [first, replay]) {
      expect(result).toMatchObject({
        ok: false,
        refusal: {
          message: sentence,
          details: {
            reason: 'attachFailed',
            argumentProblem: { agent: 'Grok', option: '--cwd', problem: 'unsupportedOption' }
          }
        }
      })
    }
    expect(JSON.stringify([first, replay])).not.toContain('private')
    expect(spawned).toEqual([])
  })

  it('refuses a Command that names no runnable program, in the words its replay reads', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { first, replay, spawned } = await attachUnder({
      launchArgs: [],
      resolveCommand: () => {
        throw new AgentSessionPreSpawnError('the grok Command setting is not a runnable program', {
          reason: 'agentCommandNotRunnable'
        })
      }
    })
    const sentence =
      "Grok's Command in Settings → Agents must be a program path or name Orca can find, with no arguments or variables. Change it or reset it."
    // Thrown, as Claude's and Codex's are: the wire carries the sentence, never the raw message.
    for (const result of [first, replay]) {
      expect(result).toMatchObject({ reason: 'agentCommandNotRunnable' })
      expect(mapRuntimeError('req-1', { runtimeId: 'runtime-1' }, result)).toMatchObject({
        ok: false,
        error: { code: 'runtime_error', message: sentence }
      })
    }
    expect(spawned).toEqual([])
  })
})
