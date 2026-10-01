import { describe, expect, it, vi } from 'vitest'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import type {
  ClaudeStreamJsonConnection,
  ClaudeStreamJsonConnectionHandlers,
  ClaudeStreamJsonLaunch
} from '../claude/claude-stream-json-connection'
import { refreshClaudeLoginViaCli } from './claude-cli-login-refresh'

vi.mock('./hidden-rate-limit-pty-cwd', () => ({
  resolveHiddenRateLimitPtyCwd: () => '/tmp/orca-test/rate-limit-pty-cwd'
}))

const authPreparation: ClaudeRuntimeAuthPreparation = {
  configDir: '/Users/test/managed/account-1',
  runtime: 'host',
  wslDistro: null,
  wslLinuxConfigDir: null,
  envPatch: { CLAUDE_CONFIG_DIR: '/Users/test/managed/account-1' },
  stripAuthEnv: true,
  provenance: 'managed:account-1'
}

function fakeConnect(getUsage: (handlers: ClaudeStreamJsonConnectionHandlers) => Promise<unknown>) {
  const seen: { launch?: ClaudeStreamJsonLaunch; closes: number; usageTimeout?: number } = {
    closes: 0
  }
  const connect = vi.fn(
    async (launch: ClaudeStreamJsonLaunch, handlers: ClaudeStreamJsonConnectionHandlers = {}) => {
      seen.launch = launch
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refresh only calls getUsage and close.
      return {
        getUsage: (options?: { timeoutMs?: number }) => {
          seen.usageTimeout = options?.timeoutMs
          return getUsage(handlers)
        },
        close: async () => {
          seen.closes += 1
          return true
        }
      } as unknown as ClaudeStreamJsonConnection
    }
  )
  return { connect, seen }
}

describe('refreshClaudeLoginViaCli', () => {
  it('asks the account’s own Claude for usage in an isolated session-less child, then closes it', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-key')
    const { connect, seen } = fakeConnect(async () => ({ rate_limits_available: true }))

    await expect(
      refreshClaudeLoginViaCli({
        authPreparation,
        networkProxySettings: { httpProxyUrl: 'http://proxy.test:8080' },
        connect,
        resolveCommand: () => '/fake/bin/claude'
      })
    ).resolves.toEqual({ kind: 'answered' })

    expect(seen.launch).toMatchObject({
      pathToClaudeCodeExecutable: '/fake/bin/claude',
      cwd: '/tmp/orca-test/rate-limit-pty-cwd',
      options: {
        settingSources: ['user'],
        persistSession: false,
        strictMcpConfig: true,
        mcpServers: {},
        settings: { disableAllHooks: true }
      }
    })
    expect(seen.launch?.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/Users/test/managed/account-1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false'
    })
    expect(seen.launch?.env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(Object.values(seen.launch?.env ?? {})).toContain('http://proxy.test:8080')
    expect(seen.usageTimeout).toBeGreaterThan(0)
    expect(seen.closes).toBe(1)
    vi.unstubAllEnvs()
  })

  it('reports a CLI without get_usage as unsupported', async () => {
    const { connect, seen } = fakeConnect(async () => {
      throw new Error('Unsupported control request subtype: get_usage')
    })

    await expect(
      refreshClaudeLoginViaCli({ authPreparation, connect, resolveCommand: () => '/fake/claude' })
    ).resolves.toMatchObject({ kind: 'unsupported' })
    expect(seen.closes).toBe(1)
  })

  it('reports why the CLI exited before it answered', async () => {
    const { connect, seen } = fakeConnect(async (handlers) => {
      handlers.onFault?.(new Error('claude stream-json exited (code 1): accept the updated terms'))
      throw new Error('Query closed before response received')
    })

    await expect(
      refreshClaudeLoginViaCli({ authPreparation, connect, resolveCommand: () => '/fake/claude' })
    ).resolves.toEqual({
      kind: 'failed',
      message: 'claude stream-json exited (code 1): accept the updated terms'
    })
    expect(seen.closes).toBe(1)
  })

  it('closes the child when the fetch is aborted mid-request', async () => {
    const controller = new AbortController()
    const { connect, seen } = fakeConnect(async () => {
      controller.abort()
      throw new Error('Query closed before response received')
    })

    await expect(
      refreshClaudeLoginViaCli({
        authPreparation,
        connect,
        signal: controller.signal,
        resolveCommand: () => '/fake/claude'
      })
    ).resolves.toMatchObject({ kind: 'failed' })
    expect(seen.closes).toBeGreaterThanOrEqual(1)
  })

  it('starts nothing when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { connect } = fakeConnect(async () => ({}))

    await expect(
      refreshClaudeLoginViaCli({ authPreparation, connect, signal: controller.signal })
    ).resolves.toMatchObject({ kind: 'failed' })
    expect(connect).not.toHaveBeenCalled()
  })
})
