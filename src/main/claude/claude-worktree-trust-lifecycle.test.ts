import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

const { request } = vi.hoisted(() => ({ request: vi.fn(async () => ({ ok: true })) }))
vi.mock('../ssh/ssh-target-registry', () => ({
  getActiveMultiplexer: () => ({ request, isDisposed: () => false })
}))

import {
  revokeAllClaudeWorktreeTrust,
  revokeClaudeWorktreeTrustForRemoval
} from './claude-worktree-trust-lifecycle'

let root: string
let configFile: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-claude-trust-life-')))
  const configDir = join(root, 'cfg')
  mkdirSync(configDir)
  configFile = join(configDir, '.claude.json')
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  request.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

const meta: WorktreeMeta = {
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
  orcaCreationSource: 'desktop',
  orcaCreationContentOrigin: 'repo-ref'
}

function store(
  repo: Repo,
  worktreeId: string,
  agentDefaultEnv: { claude?: Record<string, string> } = {}
) {
  return {
    getRepo: (id: string) => (id === repo.id ? repo : undefined),
    getWorktreeMeta: (id: string) => (id === worktreeId ? meta : undefined),
    getAllWorktreeMeta: () => ({ [worktreeId]: meta }),
    getSettings: () => ({ claudeTrustOrcaWorktrees: true, agentDefaultEnv })
  }
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'r',
    path: join(root, 'repo'),
    displayName: 'r',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    ...overrides
  }
}

describe('Claude worktree trust lifecycle', () => {
  it('removes the entry Orca wrote when Orca removes the worktree, even if the setting is on', async () => {
    const worktree = join(root, 'wt')
    writeFileSync(
      configFile,
      JSON.stringify({ projects: { [worktree]: { hasTrustDialogAccepted: true } } }),
      { mode: 0o600 }
    )
    revokeClaudeWorktreeTrustForRemoval(store(repo(), `r::${worktree}`), `r::${worktree}`)
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(configFile, 'utf-8'))).toEqual({ projects: {} })
    )
  })

  it('asks the relay to revoke an SSH worktree instead of touching this machine', async () => {
    const worktree = '/remote/wt'
    await revokeAllClaudeWorktreeTrust(store(repo({ connectionId: 'ssh-1' }), `r::${worktree}`))
    expect(request).toHaveBeenCalledWith('claudeTrust.converge', {
      request: { worktreeRoot: worktree, mainCheckoutPath: join(root, 'repo'), trusted: false },
      env: {}
    })
  })

  it("sends the relay the Claude config dir a launch would use, and nothing else from Claude's env", async () => {
    const worktree = '/remote/wt'
    await revokeAllClaudeWorktreeTrust(
      store(repo({ connectionId: 'ssh-1' }), `r::${worktree}`, {
        claude: { CLAUDE_CONFIG_DIR: '/remote/cfg', ANTHROPIC_MODEL: 'x' }
      })
    )
    expect(request).toHaveBeenCalledWith('claudeTrust.converge', {
      request: { worktreeRoot: worktree, mainCheckoutPath: join(root, 'repo'), trusted: false },
      env: { CLAUDE_CONFIG_DIR: '/remote/cfg' }
    })
  })
})
