import { describe, expect, it } from 'vitest'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { OpenCodeStructuredSessionAdapter } from './opencode-structured-session-adapter'
import type { OpenCodeStructuredLaunch } from './opencode-structured-session-state'

const LAUNCH: OpenCodeStructuredLaunch = {
  command: 'opencode',
  cwd: '/workspace',
  environment: {},
  resumeSessionId: null,
  permissions: [],
  agent: 'opencode'
}

describe('OpenCode structured acquisition', () => {
  it('does not spawn after a close overtakes launch resolution', async () => {
    let resolveLaunch = (_launch: OpenCodeStructuredLaunch): void => {}
    const launch = new Promise<OpenCodeStructuredLaunch>((resolve) => {
      resolveLaunch = resolve
    })
    let spawned = 0
    const adapter = new OpenCodeStructuredSessionAdapter({
      resolveLaunch: () => launch,
      openServer: async () => {
        spawned += 1
        throw new Error('unexpected spawn')
      }
    })
    const acquiring = adapter.acquire({
      identity: {
        sessionId: 'chat',
        workspaceId: 'workspace',
        hostId: 'host',
        agent: 'opencode',
        providerHandle: null
      },
      fence: 2,
      spawnToken: 'spawn-token'
    })
    const closing = adapter.closeSession('chat')
    resolveLaunch(LAUNCH)
    await expect(acquiring).rejects.toBeInstanceOf(AgentSessionPreSpawnError)
    await expect(closing).resolves.toBe(true)
    expect(spawned).toBe(0)
  })
})
