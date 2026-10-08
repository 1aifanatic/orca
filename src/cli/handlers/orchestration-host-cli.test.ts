import { afterEach, expect, it, vi } from 'vitest'
import { ORCHESTRATION_HANDLERS } from './orchestration'
import { RuntimeClient } from '../runtime-client'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it.each(['question', 'resume'])(
  'an owning-host Windows launcher delivers orchestration ask --%s',
  async (kind) => {
    vi.stubEnv('ORCA_CLI_COMMAND', 'C:\\orca-host\\bin\\orca.exe')
    vi.stubEnv('ORCA_CLI_OWNING_HOST', '1')
    vi.stubEnv('ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER', '1')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
    vi.stubEnv('ORCA_STRUCTURED_SESSION', '')
    const client = new RuntimeClient('/isolated', 1000, null, null)
    const call = vi.spyOn(client, 'call').mockResolvedValue({
      id: 'req_ask',
      ok: true,
      result: { answer: 'yes', messageId: 'msg_1', threadId: 'msg_1', timedOut: false },
      _meta: { runtimeId: 'runtime-owner' }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await ORCHESTRATION_HANDLERS['orchestration ask']({
      flags: new Map<string, string | boolean>([
        ['from', 'term_worker'],
        [kind, kind === 'question' ? 'Proceed?' : 'msg_1']
      ]),
      client,
      cwd: '/isolated',
      json: true
    })
    expect(call).toHaveBeenCalledWith(
      'orchestration.ask',
      expect.objectContaining({
        [kind]: kind === 'question' ? 'Proceed?' : 'msg_1',
        compatibilityWindowsCommand: undefined
      }),
      expect.any(Object)
    )
  }
)
