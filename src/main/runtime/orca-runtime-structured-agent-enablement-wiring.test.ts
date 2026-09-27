import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const installed = vi.hoisted(() => {
  const state: { deps: Record<string, unknown> | null } = { deps: null }
  return state
})

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('./structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: vi.fn(async (deps: Record<string, unknown>) => {
    installed.deps = deps
  })
}))

import { OrcaRuntimeService } from './orca-runtime'
import type * as StructuredAgentSessionRuntimeModule from './structured-agent-session-runtime'

function installedEnablementReader(): ((agent: string) => boolean) | undefined {
  const read = installed.deps?.['isAgentEnabled']
  return typeof read === 'function' ? (agent: string) => read(agent) === true : undefined
}

/** The host's attach gate is the only enablement check `agentSession.ensure` and `/clear` pass, and
 *  the runtime file that wires it does not typecheck, so pin the hookup behaviourally. */
describe('structured agent enablement wiring', () => {
  it('hands the host a reader of the live disabled-agents setting', async () => {
    installed.deps = null
    const settings = { disabledTuiAgents: ['codex'] }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: host install reads only getSettings here; the rest of the store is never touched.
    const runtime = new OrcaRuntimeService({ getSettings: () => settings } as never)

    await runtime.ensureStructuredAgentSessionHost()

    const isAgentEnabled = installedEnablementReader()
    expect(isAgentEnabled?.('codex')).toBe(false)
    expect(isAgentEnabled?.('claude')).toBe(true)
    settings.disabledTuiAgents = []
    expect(isAgentEnabled?.('codex')).toBe(true)
  })

  it('refuses to install a host without a reader rather than enabling every agent', async () => {
    const runtimeModule = await vi.importActual<typeof StructuredAgentSessionRuntimeModule>(
      './structured-agent-session-runtime'
    )
    const stateDirectory = await mkdtemp(join(tmpdir(), 'orca-enablement-wiring-'))
    const withoutReader = {
      stateDirectory,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => stateDirectory,
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true })
    }
    try {
      await expect(
        runtimeModule.ensureStructuredAgentSessionHost(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: omits the required reader on purpose, as the untyped production caller could.
          withoutReader as unknown as Parameters<
            typeof runtimeModule.ensureStructuredAgentSessionHost
          >[0]
        )
      ).rejects.toThrow(runtimeModule.STRUCTURED_AGENT_ENABLEMENT_READER_REQUIRED)
    } finally {
      await runtimeModule.stopStructuredAgentSessionRuntime()
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
})
