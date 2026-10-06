import { getSystemCodexHomePath } from './codex-home-paths'
import { AgentModelCatalogUnavailableError } from '../native-chat/agent-model-catalog/agent-model-catalog-availability'
import { describe, expect, it, vi } from 'vitest'
import { createCodexModelCatalogProbe } from './codex-model-catalog-probe'
import { resolveCodexStructuredInvocation } from './codex-structured-launch-resolution'
import { runCodexAppServerSession, type CodexAppServerInvocation } from './codex-app-server-session'

const MODEL_ROW = {
  model: 'gpt-live',
  displayName: 'GPT Live',
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
  isDefault: true
}

describe('codex model catalog probe', () => {
  it('spawns with the same resolved command and env as a structured session launch', async () => {
    // The env a user's shell/config resolves for sessions, PATH included.
    const resolveEnvironment = async (): Promise<NodeJS.ProcessEnv> => ({
      PATH: '/resolved/bin',
      HOME: '/homes/user',
      OPENAI_BASE_URL: 'https://gateway.example',
      DROPPED: undefined
    })
    const resolveCommand = vi.fn((options?: { pathEnv?: string | null; homePath?: string }) => {
      expect(options?.pathEnv).toBe('/resolved/bin')
      expect(options?.homePath).toBe('/homes/user')
      return '/resolved/bin/codex'
    })
    const invocations: CodexAppServerInvocation[] = []
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment,
      resolveCommand,
      runSession: async (invocation, body) => {
        invocations.push(invocation)
        return body({
          request: async () => ({ data: [MODEL_ROW], nextCursor: null }),
          notify: () => {}
        })
      }
    })
    const success = await probe('/homes/account-a')
    expect(success.origin).toBe('probe')
    expect(success.models.map((model) => model.id)).toEqual(['gpt-live'])
    // The session launch resolves the exact same invocation for the same deps.
    const sessionInvocation = await resolveCodexStructuredInvocation({
      resolveEnvironment,
      resolveCommand
    })
    expect(invocations).toHaveLength(1)
    expect(invocations[0]!.cliPath).toBe(sessionInvocation.command)
    expect(invocations[0]!.env).toEqual({
      PATH: '/resolved/bin',
      HOME: '/homes/user',
      OPENAI_BASE_URL: 'https://gateway.example',
      CODEX_HOME: '/homes/account-a'
    })
    // A short-lived probe must not start plugin marketplace clones that outlive its teardown.
    expect(invocations[0]!.args.join(' ')).toContain('features.plugins=false')
  })

  it('keeps the listing when config/read never answers', async () => {
    const server = String.raw`
      const readline = require('node:readline')
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line)
        if (typeof message.id !== 'number' || message.method === 'config/read') return
        const result = message.method === 'model/list'
          ? { data: [${JSON.stringify(MODEL_ROW)}], nextCursor: null }
          : {}
        process.stdout.write(JSON.stringify({ id: message.id, result }) + '\n')
      })
    `
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({ PATH: '/bin' }),
      resolveCommand: () => '/bin/codex',
      // Real transport against a fake server; a session deadline shorter than the
      // production one keeps the test fast while still outliving config/read's bound.
      runSession: (invocation, body) =>
        runCodexAppServerSession(
          {
            ...invocation,
            command: process.execPath,
            cliPath: null,
            args: ['-e', server],
            timeoutMs: 6_000
          },
          body
        )
    })
    const success = await probe('/homes/a')
    expect(success.models.map((model) => ({ id: model.id, isDefault: model.isDefault }))).toEqual([
      { id: 'gpt-live', isDefault: true }
    ])
  }, 10_000)

  it('refuses an empty listing rather than reporting it as a catalog', async () => {
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({ PATH: '/bin' }),
      resolveCommand: () => '/bin/codex',
      runSession: async (_invocation, body) =>
        body({ request: async () => ({ data: [], nextCursor: null }), notify: () => {} })
    })
    await expect(probe('/homes/a')).rejects.toThrow(/listed no models/)
  })
})

describe('Codex catalog availability', () => {
  function withAccount(account: unknown) {
    return createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({}),
      resolveCommand: () => 'codex',
      resolveAccountKind: (home) => (home === getSystemCodexHomePath() ? 'system' : 'managed'),
      runSession: async (_invocation, body) =>
        body({
          request: async (method, params, options) => {
            if (method === 'account/read') {
              expect(params).toEqual({ refreshToken: false })
              expect(options?.timeoutMs).toBe(2000)
              if (account instanceof Error) {
                throw account
              }
              return account
            }
            return { data: [MODEL_ROW], nextCursor: null }
          },
          notify: () => {}
        })
    })
  }
  it.each([
    null,
    {},
    { account: null },
    { requiresOpenaiAuth: true },
    { account: null, requiresOpenaiAuth: false },
    { account: {}, requiresOpenaiAuth: true },
    { account: null, requiresOpenaiAuth: 'true' },
    new Error('unsupported method'),
    new Error('timeout')
  ])('unknown or authenticated account does not block: %j', async (account) => {
    expect((await withAccount(account)('/homes/a')).models).toHaveLength(1)
  })
  it.each([
    ['/homes/a', 'managed'],
    [getSystemCodexHomePath(), 'system']
  ] as const)('reports explicit signed-out account for %s', async (home, account) => {
    await expect(
      withAccount({ account: null, requiresOpenaiAuth: true })(home)
    ).rejects.toMatchObject({ unavailable: { reason: 'notSignedIn', account } })
  })
  it('omits unknown account context from a positive signed-out fact', async () => {
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({}),
      resolveCommand: () => 'codex',
      runSession: async (_invocation, body) =>
        body({
          request: async () => ({ account: null, requiresOpenaiAuth: true }),
          notify: () => {}
        })
    })
    const error = await probe('/custom/home').catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AgentModelCatalogUnavailableError)
    if (error instanceof AgentModelCatalogUnavailableError) {
      expect(error.unavailable).toEqual({ reason: 'notSignedIn' })
      expect(error.unavailable).not.toHaveProperty('account')
    }
  })
  it.each(['ENOENT', 'EACCES'])('classifies only missing executable errors: %s', async (code) => {
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({}),
      resolveCommand: () => 'codex',
      runSession: async () => {
        throw Object.assign(new Error('spawn failed'), { code, path: 'codex' })
      }
    })
    const failure = await probe('/homes/a').catch((error: unknown) => error)
    expect(failure instanceof AgentModelCatalogUnavailableError).toBe(code === 'ENOENT')
  })
})
