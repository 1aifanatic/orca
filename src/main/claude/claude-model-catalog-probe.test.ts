import { createMockDiscoveryChild } from '../text-generation/commit-message-text-generation-test-harness'
import { CLAUDE_CATALOG_STDIN } from '../../shared/claude-model-list-probe'
import { AgentModelCatalogUnavailableError } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeModelCatalogProbe } from './claude-model-catalog-probe'
import { resolveClaudeStructuredInvocation } from './claude-structured-launch-resolution'
import type { discoverModelsLocal } from '../text-generation/commit-message-model-discovery'
import type {
  SpawnedSourceControlAgentProcess,
  SpawnSourceControlAgent
} from '../text-generation/source-control-text-generation-types'

type DiscoverInput = Parameters<typeof discoverModelsLocal>[0]
type DiscoverResult = Awaited<ReturnType<typeof discoverModelsLocal>>

const AUTH_POLICY = { stripAuthEnv: false } as const

function probeDeps(): {
  resolveCommand: () => string
  resolveEnv: () => Record<string, string>
  resolveInheritedEnv: () => Promise<Record<string, string>>
  resolveAuthPolicy: () => typeof AUTH_POLICY
} {
  return {
    resolveCommand: () => '/resolved/claude with spaces/claude',
    resolveEnv: () => ({ ANTHROPIC_MODEL_GATEWAY: 'https://gateway.example' }),
    resolveInheritedEnv: async () => ({ PATH: '/resolved/bin', HOME: '/homes/user' }),
    resolveAuthPolicy: () => AUTH_POLICY
  }
}

function listedResult(): DiscoverResult {
  return {
    success: true,
    capability: {
      id: 'claude',
      label: 'Claude',
      modelSource: 'dynamic',
      defaultModelId: 'sonnet',
      models: []
    },
    models: [
      {
        id: 'sonnet',
        label: 'Sonnet',
        isDefault: true,
        thinkingLevels: [{ id: 'low', label: 'Low' }],
        defaultThinkingLevel: 'low'
      }
    ],
    defaultModelId: 'sonnet',
    catalogOrigin: 'probe'
  }
}

describe('claude model catalog probe', () => {
  it('lists under the same resolved command and env as a structured session launch', async () => {
    const deps = probeDeps()
    const captured: DiscoverInput[] = []
    const spawnAgent = vi.fn<SpawnSourceControlAgent>(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake discover below never reads the returned child.
      () => ({}) as SpawnedSourceControlAgentProcess
    )
    const probe = createClaudeModelCatalogProbe({
      ...deps,
      spawnAgent,
      discover: async (input) => {
        captured.push(input)
        // Drive the probe's spawn wrapper once, the way the real listing would.
        input.spawnAgent({
          binary: 'claude',
          args: ['--list'],
          env: input.env,
          stdinMode: 'ignore',
          useCwdForNative: false
        })
        return listedResult()
      }
    })
    const success = await probe('/homes/account-a')
    expect(success.origin).toBe('probe')
    expect(success.models).toEqual([
      {
        id: 'sonnet',
        label: 'Sonnet',
        isDefault: true,
        // The spec's `defaultThinkingLevel` is not what Claude runs; naming it would label the effort.
        efforts: [{ value: 'low', label: 'Low' }]
      }
    ])
    // The probe's env is exactly the session launch's resolved env for the
    // same deps, plus the account pin — and the spawn runs the resolved
    // binary, never the bare spec name.
    const invocation = await resolveClaudeStructuredInvocation(deps, (env) => ({
      ...env,
      CLAUDE_CONFIG_DIR: '/homes/account-a'
    }))
    expect(captured).toHaveLength(1)
    expect(captured[0]!.env).toEqual(invocation.env)
    expect(captured[0]!.agentCommandOverride).toBeUndefined()
    expect(spawnAgent).toHaveBeenCalledTimes(1)
    expect(spawnAgent.mock.calls[0]![0].binary).toBe(invocation.command)
  })

  it('pins no CLAUDE_CONFIG_DIR for the CLI default home, exactly as a session spawn does', async () => {
    const envs: DiscoverInput['env'][] = []
    const probe = createClaudeModelCatalogProbe({
      ...probeDeps(),
      discover: async (input) => {
        envs.push(input.env)
        return listedResult()
      }
    })
    await probe(join(homedir(), '.claude'))
    await probe('/homes/account-a')
    // An explicit default would move the CLI off its default Keychain item (claude.ai OAuth).
    expect(envs[0]).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(envs[1]).toMatchObject({ CLAUDE_CONFIG_DIR: '/homes/account-a' })
  })

  it('refuses a static-fallback answer rather than reporting it as a catalog', async () => {
    const probe = createClaudeModelCatalogProbe({
      ...probeDeps(),
      discover: async () => ({ ...listedResult(), catalogOrigin: 'spec' })
    })
    await expect(probe('/homes/a')).rejects.toThrow(/listed no models/)
  })
})

describe('Claude catalog availability', () => {
  it.each([false, true])(
    'reads initialization in the same listing for managed=%s',
    async (managed) => {
      const probe = createClaudeModelCatalogProbe({
        ...probeDeps(),
        resolveEnv: () => ({}),
        resolveAuthPolicy: () => ({ stripAuthEnv: managed }),
        discover: async (input) => {
          expect(input.stdinPayload).toBe(CLAUDE_CATALOG_STDIN)
          expect(input.binary).toBe('/resolved/claude with spaces/claude')
          const unavailable = input.inspectOutput?.(
            JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: 'orca-catalog-initialize',
                response: { account: { tokenSource: 'none' } }
              }
            })
          )
          return { success: false, error: 'notSignedIn', unavailable }
        }
      })
      await expect(probe('/homes/a')).rejects.toMatchObject({
        unavailable: { reason: 'notSignedIn', account: managed ? 'managed' : 'system' }
      })
    }
  )
  it('retains typed missing CLI evidence', async () => {
    const probe = createClaudeModelCatalogProbe({
      ...probeDeps(),
      discover: async () => ({
        success: false,
        error: 'missing',
        unavailable: { reason: 'cliMissing' }
      })
    })
    await expect(probe('/homes/a')).rejects.toBeInstanceOf(AgentModelCatalogUnavailableError)
  })
  it('does not turn a generic discovery failure into unavailable', async () => {
    const probe = createClaudeModelCatalogProbe({
      ...probeDeps(),
      discover: async () => ({ success: false, error: 'timeout' })
    })
    await expect(probe('/homes/a')).rejects.not.toBeInstanceOf(AgentModelCatalogUnavailableError)
  })
})

describe('Claude catalog fake-child contract', () => {
  it.each(['none', 'oauth'])(
    'initializes and lists in one process for tokenSource=%s',
    async (tokenSource) => {
      const child = createMockDiscoveryChild()
      const spawnAgent = vi.fn<SpawnSourceControlAgent>(() => {
        queueMicrotask(() => {
          child.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                type: 'control_response',
                response: {
                  request_id: 'orca-catalog-initialize',
                  subtype: 'success',
                  response: { account: { tokenSource } }
                }
              })}\n${JSON.stringify({
                type: 'control_response',
                response: {
                  request_id: 'orca-model-discovery',
                  subtype: 'success',
                  response: { models: [{ value: 'sonnet', displayName: 'Sonnet' }] }
                }
              })}\n`
            )
          )
          child.emit('close', 0)
        })
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: discovery reads only the fake child's EventEmitter streams, pid, kill and stdin.end.
        return child as unknown as SpawnedSourceControlAgentProcess
      })
      const probe = createClaudeModelCatalogProbe({ ...probeDeps(), spawnAgent })
      const result = await probe('/homes/a').catch((error: unknown) => error)
      if (tokenSource === 'none') {
        expect(result).toMatchObject({ unavailable: { reason: 'notSignedIn', account: 'system' } })
      } else {
        expect(result).toMatchObject({ models: [{ id: 'sonnet' }] })
      }
      expect(spawnAgent).toHaveBeenCalledTimes(1)
      expect(child.stdin.end).toHaveBeenCalledWith(CLAUDE_CATALOG_STDIN)
    }
  )
  it('preserves the resolved executable missing error from a child', async () => {
    const child = createMockDiscoveryChild()
    const probe = createClaudeModelCatalogProbe({
      ...probeDeps(),
      spawnAgent: () => {
        queueMicrotask(() =>
          child.emit(
            'error',
            Object.assign(new Error('missing'), {
              code: 'ENOENT',
              path: '/resolved/claude with spaces/claude'
            })
          )
        )
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: discovery reads only the fake child's EventEmitter streams, pid, kill and stdin.end.
        return child as unknown as SpawnedSourceControlAgentProcess
      }
    })
    await expect(probe('/homes/a')).rejects.toMatchObject({ unavailable: { reason: 'cliMissing' } })
  })
})
