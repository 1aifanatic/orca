import { beforeAll, describe, expect, it } from 'vitest'
import {
  RUNTIME_CAPABILITIES,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { resolveStructuredNativeChatSupport } from '../../../src/shared/structured-native-chat-launch-route'
import { resolveAgentLaunchRoute } from '../../../src/renderer/src/lib/agent-launch-routing'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// This release advertises structured chat but predates client-chosen launch modes.
const LEGACY_PAIRED_STRUCTURED_LAUNCH_RELEASE_REF = 'v1.4.219'
const SETTINGS = {
  experimentalNativeChat: true,
  experimentalStructuredNativeChat: true,
  openAgentTabsInChatByDefault: true
}
const LAUNCHES = [
  { agent: 'claude', workspaceKind: 'git-worktree' },
  { agent: 'codex', workspaceKind: 'git-worktree' },
  { agent: 'claude', workspaceKind: 'folder' },
  { agent: 'codex', workspaceKind: 'folder' }
] as const

let legacyHostCapabilities: readonly string[]

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(LEGACY_PAIRED_STRUCTURED_LAUNCH_RELEASE_REF)
  const protocol = await importReleaseCheckoutModule(checkout, '/src/shared/protocol-version.ts')
  const capabilities = protocol.RUNTIME_CAPABILITIES
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every((value: unknown): value is string => typeof value === 'string')
  ) {
    throw new Error('The legacy release must publish its runtime capabilities')
  }
  legacyHostCapabilities = capabilities
}, 180_000)

describe('desktop structured launch against a paired runtime', () => {
  it('reads a real release that has structured chat but lacks client-chosen launch modes', () => {
    expect(legacyHostCapabilities).toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    expect(legacyHostCapabilities).not.toContain(
      STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
    )
  })

  it.each(LAUNCHES)(
    'new client refuses an old server for $agent in a $workspaceKind workspace',
    (launch) => {
      const input = {
        ...launch,
        executionHostId: 'runtime:server-1',
        hostCapabilities: legacyHostCapabilities,
        clientCapabilities: RUNTIME_CAPABILITIES
      }
      expect(resolveStructuredNativeChatSupport(input)).toEqual({
        supported: false,
        blocker: 'runtime-capability'
      })
      expect(resolveAgentLaunchRoute({ ...input, settings: SETTINGS })).toBe('legacy-native-chat')
    }
  )

  it.each(LAUNCHES)(
    'new client opens structured $agent on a capable server in a $workspaceKind workspace',
    (launch) => {
      const input = {
        ...launch,
        executionHostId: 'runtime:server-1',
        hostCapabilities: RUNTIME_CAPABILITIES,
        clientCapabilities: RUNTIME_CAPABILITIES
      }
      expect(resolveStructuredNativeChatSupport(input)).toEqual({ supported: true })
      expect(resolveAgentLaunchRoute({ ...input, settings: SETTINGS })).toBe(
        'structured-native-chat'
      )
    }
  )
})
