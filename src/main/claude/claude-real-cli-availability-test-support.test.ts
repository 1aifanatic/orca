import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REAL_AGENT_TESTS_ENV,
  realAgentTestsEnabled
} from '../real-agent-tests-opt-in-test-support'

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn<(program: string, args: readonly string[]) => unknown>(() => ({
    status: 1,
    signal: null,
    stdout: '',
    stderr: '',
    pid: 0
  }))
}))

// Why the lowest layer: nothing below this helper may start a process, whichever wrapper it uses.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawn: spawnMock,
  spawnSync: spawnSyncMock
}))

// Why a missing path: even a mock that failed to apply could not reach a real CLI.
vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: () => '/nonexistent/orca-test-claude'
}))

async function loadAvailability() {
  vi.resetModules()
  return import('./claude-real-cli-availability-test-support')
}

describe('real Claude CLI availability', () => {
  beforeEach(() => {
    spawnMock.mockClear()
    spawnSyncMock.mockClear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('skips without spawning anything unless real-agent tests are opted into', async () => {
    vi.stubEnv(REAL_AGENT_TESTS_ENV, undefined)

    const { realClaudeSkipReason, realClaudeAuthStatus } = await loadAvailability()

    expect(realClaudeSkipReason).toContain(`${REAL_AGENT_TESTS_ENV}=1`)
    expect(realClaudeAuthStatus).toBeNull()
    expect(spawnSyncMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('probes the CLI once opted into', async () => {
    vi.stubEnv(REAL_AGENT_TESTS_ENV, '1')

    const { realClaudeSkipReason } = await loadAvailability()

    // The mocked probe fails, so this proves the gate, not a real CLI.
    expect(realClaudeSkipReason).toMatch(/no runnable Claude CLI/)
    expect(spawnSyncMock).toHaveBeenCalledTimes(1)
    expect(spawnSyncMock.mock.calls[0]?.[1]).toContain('--version')
  })
})

describe('realAgentTestsEnabled', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['0', false],
    ['true', false],
    ['1', true]
  ])('%j -> %s', (value, expected) => {
    expect(realAgentTestsEnabled({ [REAL_AGENT_TESTS_ENV]: value })).toBe(expected)
  })
})
