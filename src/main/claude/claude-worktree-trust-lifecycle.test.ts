import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

const { request } = vi.hoisted(() => ({ request: vi.fn(async () => ({ ok: true })) }))
vi.mock('../ssh/ssh-target-registry', () => ({
  getActiveMultiplexer: () => ({ request, isDisposed: () => false })
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(actual.writeFileSync)
  }
})

import { convergeClaudeWorktreesTrustOnHost } from './claude-worktree-trust-host'
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
  request.mockReset()
  request.mockResolvedValue({ ok: true })
  vi.mocked(readFileSync).mockClear()
  vi.mocked(writeFileSync).mockClear()
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
  repos: Repo | Repo[],
  worktreeIds: string | string[],
  agentDefaultEnv: { claude?: Record<string, string> } = {}
) {
  const ids = [worktreeIds].flat()
  return {
    getRepo: (id: string) => [repos].flat().find((candidate) => candidate.id === id),
    getWorktreeMeta: (id: string) => (ids.includes(id) ? meta : undefined),
    getAllWorktreeMeta: () => Object.fromEntries(ids.map((id) => [id, meta])),
    getSettings: () => ({ claudeTrustOrcaWorktrees: true, agentDefaultEnv })
  }
}

function readsOf(file: string): number {
  return vi.mocked(readFileSync).mock.calls.filter(([path]) => path === file).length
}

function writesOf(file: string): number {
  return vi
    .mocked(writeFileSync)
    .mock.calls.filter(([path]) => String(path).startsWith(`${file}.orca-trust-`)).length
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
      requests: [{ worktreeRoot: worktree, mainCheckoutPath: join(root, 'repo'), trusted: false }],
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
      requests: [{ worktreeRoot: worktree, mainCheckoutPath: join(root, 'repo'), trusted: false }],
      env: { CLAUDE_CONFIG_DIR: '/remote/cfg' }
    })
  })

  it('turning the setting off reads and rewrites the config once, not once per worktree', async () => {
    const worktrees = ['a', 'b', 'c'].map((name) => join(root, name))
    writeFileSync(
      configFile,
      JSON.stringify({
        projects: {
          ...Object.fromEntries(worktrees.map((wt) => [wt, { hasTrustDialogAccepted: true }])),
          '/mine': { hasTrustDialogAccepted: true, allowedTools: [] }
        }
      })
    )
    vi.mocked(readFileSync).mockClear()
    await revokeAllClaudeWorktreeTrust(
      store(
        repo(),
        worktrees.map((wt) => `r::${wt}`)
      )
    )
    // One probe, then the re-read under Claude's lock.
    expect(readsOf(configFile)).toBe(2)
    expect(writesOf(configFile)).toBe(1)
    expect(JSON.parse(readFileSync(configFile, 'utf-8'))).toEqual({
      projects: { '/mine': { hasTrustDialogAccepted: true, allowedTools: [] } }
    })
  })

  it('sends one relay request per SSH connection, and one rejecting leaves the rest', async () => {
    const worktree = join(root, 'local-wt')
    writeFileSync(
      configFile,
      JSON.stringify({ projects: { [worktree]: { hasTrustDialogAccepted: true } } })
    )
    request.mockRejectedValueOnce(new Error('method not found'))
    await revokeAllClaudeWorktreeTrust(
      store(
        [
          repo(),
          repo({ id: 's1', connectionId: 'ssh-1' }),
          repo({ id: 's2', connectionId: 'ssh-2' })
        ],
        ['s1::/remote/a', 's1::/remote/b', 's2::/remote/c', `r::${worktree}`]
      )
    )
    expect(request.mock.calls).toEqual([
      [
        'claudeTrust.converge',
        {
          requests: ['/remote/a', '/remote/b'].map((worktreeRoot) => ({
            worktreeRoot,
            mainCheckoutPath: join(root, 'repo'),
            trusted: false
          })),
          env: {}
        }
      ],
      [
        'claudeTrust.converge',
        {
          requests: [
            { worktreeRoot: '/remote/c', mainCheckoutPath: join(root, 'repo'), trusted: false }
          ],
          env: {}
        }
      ]
    ])
    expect(JSON.parse(readFileSync(configFile, 'utf-8'))).toEqual({ projects: {} })
  })
})

describe('convergeClaudeWorktreesTrustOnHost', () => {
  function configWith(dir: string, worktrees: string[]): string {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, '.claude.json')
    writeFileSync(
      file,
      JSON.stringify({
        projects: Object.fromEntries(worktrees.map((wt) => [wt, { hasTrustDialogAccepted: true }]))
      })
    )
    return file
  }

  function revocation(configFile: string, worktreeRoot: string) {
    return {
      configFile,
      worktreeRoot,
      mainCheckoutPath: null,
      trusted: false,
      keyStyle: 'posix' as const
    }
  }

  it('writes each config file once for all the worktrees it holds', async () => {
    const first = configWith(join(root, 'one'), ['/w/1', '/w/2'])
    const second = configWith(join(root, 'two'), ['/w/3', '/w/4'])
    await convergeClaudeWorktreesTrustOnHost([
      revocation(first, '/w/1'),
      revocation(second, '/w/3'),
      revocation(first, '/w/2'),
      revocation(second, '/w/4')
    ])
    for (const file of [first, second]) {
      expect(writesOf(file)).toBe(1)
      expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ projects: {} })
    }
  })

  it('still revokes in the other files when one write fails', async () => {
    const failing = configWith(join(root, 'one'), ['/w/1'])
    const healthy = configWith(join(root, 'two'), ['/w/2'])
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    await convergeClaudeWorktreesTrustOnHost([
      revocation(failing, '/w/1'),
      revocation(healthy, '/w/2')
    ])
    expect(JSON.parse(readFileSync(failing, 'utf-8'))).toEqual({
      projects: { '/w/1': { hasTrustDialogAccepted: true } }
    })
    expect(JSON.parse(readFileSync(healthy, 'utf-8'))).toEqual({ projects: {} })
  })
})
