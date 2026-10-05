import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as AppServerSession from './codex-app-server-session'

const mocks = vi.hoisted(() => ({
  runCodexAppServerSession: vi.fn(),
  runProcess: vi.fn()
}))

vi.mock('./codex-app-server-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AppServerSession>()),
  runCodexAppServerSession: mocks.runCodexAppServerSession
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: mocks.runProcess }))

import { CodexAppServerUnsupportedError } from './codex-app-server-session'
import { deriveCodexHookHashes, readCodexHookHashes } from './codex-hook-trust-derivation'
import { CODEX_EVENTS, CODEX_EVENT_LABEL } from './codex-hook-definition'

const COMMAND = '/home/u/.orca/agent-hooks/codex-hook.sh'

function listing(label: string, overrides: Record<string, unknown> = {}) {
  return {
    key: `/tmp/scratch/hooks.json:${label}:0:0`,
    command: COMMAND,
    currentHash: `sha256:${label}`,
    trustStatus: 'untrusted',
    source: 'user',
    enabled: true,
    ...overrides
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('deriveCodexHookHashes', () => {
  it("asks Codex in a throwaway CODEX_HOME holding only Orca's entries, then removes it", async () => {
    let scratchHome = ''
    mocks.runCodexAppServerSession.mockImplementation(
      async (invocation: { env?: Record<string, string> }, body: (rpc: unknown) => unknown) => {
        scratchHome = invocation.env!.CODEX_HOME!
        const written = JSON.parse(readFileSync(join(scratchHome, 'hooks.json'), 'utf-8'))
        expect(Object.keys(written.hooks).sort()).toEqual([...CODEX_EVENTS].sort())
        expect(written.hooks.Stop).toEqual([
          { hooks: [{ type: 'command', command: COMMAND, timeout: 10 }] }
        ])
        await body({
          request: async (method: string, params: { cwds: string[] }) => {
            expect(method).toBe('hooks/list')
            expect(params.cwds).toEqual([scratchHome])
          }
        })
        return {
          data: [{ hooks: CODEX_EVENTS.map((eventName) => listing(CODEX_EVENT_LABEL[eventName])) }]
        }
      }
    )

    const derived = await deriveCodexHookHashes('/bin/codex', COMMAND, 'codex-cli 0.150.1')

    expect(derived).toMatchObject({ codexVersion: 'codex-cli 0.150.1', failure: null })
    expect(derived.hashes?.stop).toBe('sha256:stop')
    expect(derived.hashes?.interrupt).toBe('sha256:interrupt')
    expect(existsSync(scratchHome)).toBe(false)
    expect(mocks.runProcess).not.toHaveBeenCalled()
  })

  it('says so, and is not retried soon, when this Codex has no hooks/list', async () => {
    mocks.runCodexAppServerSession.mockRejectedValue(
      new CodexAppServerUnsupportedError('method not found: hooks/list')
    )

    const derived = await deriveCodexHookHashes('/bin/codex', COMMAND, 'codex-cli 0.128.0')

    expect(derived).toEqual({
      codexVersion: 'codex-cli 0.128.0',
      hashes: null,
      failure: 'codex-cli 0.128.0 does not report hook approvals; update Codex for Orca status',
      transient: false
    })
  })

  it('reports a version probe that timed out as worth asking again', async () => {
    mocks.runProcess.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true })

    const derived = await deriveCodexHookHashes('/bin/codex', COMMAND)

    expect(derived).toMatchObject({ hashes: null, transient: true })
    expect(mocks.runCodexAppServerSession).not.toHaveBeenCalled()
  })
})

describe('readCodexHookHashes', () => {
  it('takes the hash of each event Codex lists once for exactly this command', () => {
    const hashes = readCodexHookHashes(
      [
        listing('stop'),
        listing('session_start'),
        listing('session_start', { currentHash: 'sha256:duplicate' }),
        listing('pre_tool_use', { command: '/other/codex-hook.sh' }),
        listing('post_tool_use', { key: '/tmp/scratch/hooks.json:post_tool_use:1:0' })
      ],
      COMMAND
    )

    expect(hashes).toEqual({ stop: 'sha256:stop' })
  })

  it('is null when Codex lists none of them', () => {
    expect(readCodexHookHashes([], COMMAND)).toBeNull()
  })
})
