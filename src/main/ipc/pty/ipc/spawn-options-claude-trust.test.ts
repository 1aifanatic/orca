import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { buildPtyIpcSpawnOptions } from './spawn-options'
import { createPtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

const orcaMeta: WorktreeMeta = {
  displayName: 'wt',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  orcaCreatedAt: 1,
  orcaCreationSource: 'ssh',
  orcaCreationContentOrigin: 'repo-ref'
}

async function buildOptions(args: PtySpawnIpcArgs, env: Record<string, string>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: buildPtyIpcSpawnOptions only reads the members stubbed here; the rest belong to later spawn stages this test never runs.
  const deps = {
    transitionSpawnHiddenRendererPtyDeliveryState: vi.fn(),
    syncPtyBackgroundedDelivery: vi.fn(),
    sendPtySpawnedToRenderer: vi.fn(),
    getSettings: () => getDefaultSettings('/tmp'),
    runtime: { registerPreAllocatedHandleForPty: vi.fn() },
    store: {
      getRepo: (id: string) =>
        id === 'repo-1'
          ? {
              id,
              path: '/remote/repo',
              displayName: 'r',
              badgeColor: '#000',
              addedAt: 0,
              kind: 'git',
              connectionId: 'ssh-1'
            }
          : undefined,
      getWorktreeMeta: () => orcaMeta,
      getSettings: () => getDefaultSettings('/tmp')
    }
  } as unknown as PtySpawnIpcDeps
  const ctx = createPtyIpcSpawnState(deps, args)
  ctx.env = env
  ctx.launchCommand = args.command
  await buildPtyIpcSpawnOptions(ctx)
  return ctx.spawnOptions
}

const PANE = { cols: 80, rows: 24 }

describe('renderer pty spawn: Claude folder trust', () => {
  it('sends the desired trust state to the relay for an Orca-created SSH worktree', async () => {
    const options = await buildOptions(
      {
        ...PANE,
        connectionId: 'ssh-1',
        worktreeId: 'repo-1::/remote/wt',
        launchAgent: 'claude',
        command: 'claude'
      },
      {}
    )
    expect(options.claudeFolderTrust).toEqual({
      worktreeRoot: '/remote/wt',
      mainCheckoutPath: '/remote/repo',
      trusted: true
    })
  })
})
