import { expect, test } from 'vitest'
import { agentSessionProviderHandleKey } from '../../../src/shared/agent-session-provider-handle-encoding'
import {
  encodePersistedAgentSessionProviderHandleChain,
  type AgentSessionProviderHandle,
  type AgentSessionProviderHandleLink
} from '../../../src/shared/agent-session-provider-handle'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../src/shared/agent-session-record.test-fixture'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// The latest release: handles stored and held in their typed form.
const RELEASE_REF = 'v1.4.220'
// The main build that made handles neutral; no release has it yet. Move to the first that does.
const NEUTRAL_HANDLE_REF = 'e817b0e23747ffd6f16f2ddefea861950d82a3c0'

const acp = (nativeId: string): AgentSessionProviderHandle => ({
  transport: 'acp',
  agent: 'grok',
  nativeId
})

function link(
  linkId: string,
  nativeId: string,
  fence: number,
  extra: Partial<AgentSessionProviderHandleLink> = {}
): AgentSessionProviderHandleLink {
  return {
    linkId,
    handle: acp(nativeId),
    origin: 'created',
    mintedAtFence: fence,
    observedAt: fence * 1_000,
    ...extra
  }
}

/** The row a build that runs another agent's chats writes: its provider and handles are neutral. */
function neutralRow(chain: AgentSessionProviderHandleLink[]): unknown {
  const head = chain.at(-1)
  const fixture = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      provenHandleLinkId: head?.linkId,
      runtimeFence: head?.mintedAtFence
    })
  )
  return JSON.parse(
    JSON.stringify({
      ...fixture,
      provider: 'grok',
      accountHome: { variable: 'GROK_HOME', path: '/home/user/.grok' },
      providerHandleChain: encodePersistedAgentSessionProviderHandleChain(chain)
    })
  )
}

const REOPENED = [link('l1', 's-1', 1), link('l2', 's-1', 2, { origin: 'resumed' })]
const REPLACED = [
  ...REOPENED,
  link('l3', 's-2', 3, {
    replaces: {
      key: agentSessionProviderHandleKey(acp('s-1')),
      reason: 'restore-failed',
      replacedAt: 3_000
    }
  })
]

// A replacement is stored as it is held, which older builds would refuse; it is safe only because
// the rows that can hold one are rows they already set aside. Claude and Codex chains refuse it.
test.each([RELEASE_REF, NEUTRAL_HANDLE_REF])(
  '%s sets aside a chat a replacement can reach whether or not it holds one',
  async (ref) => {
    const checkout = await materializeReleaseCheckout(ref)
    const records = await importReleaseCheckoutModule(
      checkout,
      'src/shared/agent-session-record.ts'
    )
    const isRecord = records.isPersistedAgentSessionRecord
    if (typeof isRecord !== 'function') {
      throw new Error(`${ref} exports no isPersistedAgentSessionRecord`)
    }
    expect(isRecord(neutralRow(REOPENED))).toBe(false)
    expect(isRecord(neutralRow(REPLACED))).toBe(false)
  },
  300_000
)
