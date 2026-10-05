import { expect, test } from 'vitest'
import {
  agentSessionProviderHandleKey,
  codexProviderHandle
} from '../../../src/shared/agent-session-provider-handle-encoding'
import type { AgentSessionProviderHandleLink } from '../../../src/shared/agent-session-provider-handle'
import {
  isPersistedAgentSessionRecord,
  type AgentSessionRecord
} from '../../../src/shared/agent-session-record'
import {
  decodePersistedAgentSessionRecord,
  encodeAgentSessionRecord
} from '../../../src/shared/agent-session-record-stored-form'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../src/shared/agent-session-record.test-fixture'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// The latest release: handles stored and held in their typed form, no stored-form decode.
const RELEASE_REF = 'v1.4.220'
// The main build that made handles neutral and added supersession; no release has it yet. Move to
// the first release that does.
const NEUTRAL_HANDLE_REF = 'e817b0e23747ffd6f16f2ddefea861950d82a3c0'

function releaseExport<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (typeof value !== 'function') {
    throw new Error(`the pinned build exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a function the pinned build exports; each caller names the signature it calls, and a changed one fails the test.
  return value as T
}

const lostKey = (threadId: string) => agentSessionProviderHandleKey(codexProviderHandle(threadId))

function link(
  linkId: string,
  threadId: string,
  fence: number,
  extra: Partial<AgentSessionProviderHandleLink> = {}
): AgentSessionProviderHandleLink {
  return {
    linkId,
    handle: codexProviderHandle(threadId),
    origin: 'created',
    mintedAtFence: fence,
    observedAt: fence * 1_000,
    ...extra
  }
}

// A chat reopened, then lost twice: the agent now holds thread-3 and none of thread-1 or thread-2.
const CHAIN: AgentSessionProviderHandleLink[] = [
  link('l1', 'thread-1', 1),
  link('l2', 'thread-1', 2, { origin: 'resumed' }),
  link('l3', 'thread-2', 3, {
    replaces: { key: lostKey('thread-1'), reason: 'restore-failed', replacedAt: 3_000 }
  }),
  link('l4', 'thread-3', 4, {
    replaces: { key: lostKey('thread-2'), reason: 'restore-failed', replacedAt: 4_000 }
  }),
  link('l5', 'thread-3', 7, { origin: 'resumed' })
]

const RECORD: AgentSessionRecord = {
  ...agentSessionRecordFixture(agentSessionLeaseFixture({ provenHandleLinkId: 'l5' })),
  provider: 'codex',
  accountHome: { variable: 'CODEX_HOME', path: '/home/user/.codex' },
  providerHandleChain: CHAIN
}

/** The row an older build wrote after reopening the chat once more, read back by this build. */
function readBack(row: unknown): AgentSessionRecord {
  const parsed: unknown = JSON.parse(JSON.stringify(row))
  if (!isPersistedAgentSessionRecord(parsed)) {
    throw new Error('this build cannot read the row the older build wrote')
  }
  return decodePersistedAgentSessionRecord(parsed).record
}

const REOPENED_LEASE = { runtimeFence: 9, provenHandleLinkId: 'old-reopen' }

// Both probes load real old builds, including cold extraction and transforms.
test('a release reads, reopens and rewrites a chat whose conversation was replaced', async () => {
  const row: unknown = JSON.parse(JSON.stringify(encodeAgentSessionRecord(RECORD)))
  const checkout = await materializeReleaseCheckout(RELEASE_REF)
  const records = await importReleaseCheckoutModule(checkout, 'src/shared/agent-session-record.ts')
  const handles = await importReleaseCheckoutModule(
    checkout,
    'src/shared/agent-session-provider-handle.ts'
  )
  const isRecord = releaseExport<(value: unknown) => boolean>(
    records,
    'isPersistedAgentSessionRecord'
  )
  const append = releaseExport<(chain: unknown[], link: unknown) => unknown[]>(
    handles,
    'appendAgentSessionProviderHandleLink'
  )

  expect(isRecord(row)).toBe(true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the release's own guard just accepted this row, and it stores the in-memory shape.
  const stored = row as { providerHandleChain: { handle: unknown }[]; lease: object }
  // It resumes the conversation the agent holds now.
  expect(stored.providerHandleChain.at(-1)?.handle).toEqual({
    provider: 'codex',
    threadId: 'thread-3'
  })
  const providerHandleChain = append(stored.providerHandleChain, {
    linkId: 'old-reopen',
    handle: { provider: 'codex', threadId: 'thread-3' },
    origin: 'resumed',
    mintedAtFence: 9,
    observedAt: 9_000
  })
  const rewritten = {
    ...stored,
    providerHandleChain,
    lease: { ...stored.lease, ...REOPENED_LEASE }
  }
  expect(isRecord(rewritten)).toBe(true)

  // Upgraded again, nothing about what was lost went missing.
  expect(readBack(rewritten).providerHandleChain).toEqual([
    ...CHAIN,
    link('old-reopen', 'thread-3', 9, { origin: 'resumed' })
  ])
}, 300_000)

test('the build that made handles neutral reads, reopens and rewrites it too', async () => {
  const row: unknown = JSON.parse(JSON.stringify(encodeAgentSessionRecord(RECORD)))
  const checkout = await materializeReleaseCheckout(NEUTRAL_HANDLE_REF)
  const records = await importReleaseCheckoutModule(checkout, 'src/shared/agent-session-record.ts')
  const storedForm = await importReleaseCheckoutModule(
    checkout,
    'src/shared/agent-session-record-stored-form.ts'
  )
  const handles = await importReleaseCheckoutModule(
    checkout,
    'src/shared/agent-session-provider-handle.ts'
  )
  const isRecord = releaseExport<(value: unknown) => boolean>(
    records,
    'isPersistedAgentSessionRecord'
  )
  type OldRecord = { providerHandleChain: { handle: { nativeId: string } }[]; lease: object }
  const decode = releaseExport<(value: unknown) => { record: OldRecord }>(
    storedForm,
    'decodePersistedAgentSessionRecord'
  )
  const encode = releaseExport<(record: OldRecord) => unknown>(
    storedForm,
    'encodeAgentSessionRecord'
  )
  const append = releaseExport<
    (chain: unknown[], link: unknown) => OldRecord['providerHandleChain']
  >(handles, 'appendAgentSessionProviderHandleLink')

  expect(isRecord(row)).toBe(true)
  const { record } = decode(row)
  expect(record.providerHandleChain.at(-1)?.handle.nativeId).toBe('thread-3')
  const providerHandleChain = append(record.providerHandleChain, {
    linkId: 'old-reopen',
    handle: codexProviderHandle('thread-3'),
    origin: 'resumed',
    mintedAtFence: 9,
    observedAt: 9_000
  })
  const rewritten = encode({
    ...record,
    providerHandleChain,
    lease: { ...record.lease, ...REOPENED_LEASE }
  })
  expect(isRecord(rewritten)).toBe(true)

  expect(readBack(rewritten).providerHandleChain).toEqual([
    ...CHAIN,
    link('old-reopen', 'thread-3', 9, { origin: 'resumed' })
  ])
}, 300_000)
