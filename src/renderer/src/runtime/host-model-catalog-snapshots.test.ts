// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('./structured-agent-session-client', () => ({ callStructuredAgentSession: mocks.call }))
vi.mock('./local-structured-chats', () => ({ localStructuredChatsInUse: async () => true }))
vi.mock('./local-runtime-capabilities', () => ({
  subscribeLocalRuntimeCapabilitiesKnown: () => () => {}
}))

import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '@/store'
import {
  readHostModelCatalogSnapshot,
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from './host-model-catalog-snapshots'
import { installHostModelCatalogSnapshotsSync } from './host-model-catalog-snapshots-sync'

const LOCAL = { kind: 'local' } as const
const PAIRED = { kind: 'environment', environmentId: 'server-1' } as const
const NEW_CHAT = { newLaunch: true, worktree: 'wt-1', seedsModel: false }

function list(listingNamesConfiguredModel: boolean): AgentSessionModelCatalogResult {
  return {
    origin: 'probe',
    models: [{ id: 'm-1', label: 'M 1', isDefault: true, efforts: [] }],
    fetchedAt: 1,
    listingNamesConfiguredModel
  }
}

describe('host model catalog snapshots', () => {
  beforeEach(() => {
    mocks.call.mockReset()
    resetHostModelCatalogSnapshotsForTests()
  })

  it('serves a workspace’s own answer, and another’s only where the default cannot differ', () => {
    recordHostModelCatalogSnapshot(LOCAL, 'codex', null, list(true))
    // Another workspace's config may replace the default a chat naming no model would show.
    expect(readHostModelCatalogSnapshot(LOCAL, 'codex', NEW_CHAT)).toBeUndefined()
    const seeded = readHostModelCatalogSnapshot(LOCAL, 'codex', { ...NEW_CHAT, seedsModel: true })
    expect(seeded).toMatchObject({
      listingNamesConfiguredModel: false,
      models: [{ isDefault: false }]
    })
    // A reopened chat names no default anyway.
    expect(readHostModelCatalogSnapshot(LOCAL, 'codex', { ...NEW_CHAT, newLaunch: false })).toEqual(
      list(true)
    )
    recordHostModelCatalogSnapshot(LOCAL, 'codex', 'wt-1', list(true))
    expect(readHostModelCatalogSnapshot(LOCAL, 'codex', NEW_CHAT)).toEqual(list(true))
    // A list that names no default reads the same in every workspace.
    recordHostModelCatalogSnapshot(LOCAL, 'grok', null, list(false))
    expect(readHostModelCatalogSnapshot(LOCAL, 'grok', NEW_CHAT)).toEqual(list(false))
    expect(readHostModelCatalogSnapshot(PAIRED, 'codex', NEW_CHAT)).toBeUndefined()
  })

  it('drops an agent’s answers when the host says the account has no list', () => {
    recordHostModelCatalogSnapshot(LOCAL, 'codex', 'wt-1', list(true))
    recordHostModelCatalogSnapshot(LOCAL, 'codex', 'wt-1', { origin: 'unknown' })
    expect(readHostModelCatalogSnapshot(LOCAL, 'codex', NEW_CHAT)).toBeUndefined()
  })
})

describe('host model catalog snapshots sync', () => {
  let stop: (() => void) | null = null
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.call.mockResolvedValue(list(false))
    resetHostModelCatalogSnapshotsForTests()
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/tmp/orca-workspaces'),
        nativeChatSessionOptions: { claude: { model: 'opus[1m]' }, codex: {} }
      }
    })
  })
  afterEach(() => stop?.())

  it('loads the agents this machine’s chats were used with, and forgets them on an account change', async () => {
    stop = installHostModelCatalogSnapshotsSync()
    await vi.waitFor(() =>
      expect(readHostModelCatalogSnapshot(LOCAL, 'claude', NEW_CHAT)).toEqual(list(false))
    )
    // Session-less, and only for an agent with a saved pick: no CLI the user never used starts.
    expect(mocks.call.mock.calls).toEqual([
      [LOCAL, 'agentSession.modelCatalog', { agent: 'claude' }]
    ])
    const settings = useAppStore.getState().settings!
    useAppStore.setState({ settings: { ...settings, activeClaudeManagedAccountId: 'other' } })
    expect(readHostModelCatalogSnapshot(LOCAL, 'claude', NEW_CHAT)).toBeUndefined()
  })
})
