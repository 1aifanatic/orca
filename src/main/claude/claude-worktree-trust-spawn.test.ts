import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'
import type { ClaudeFolderTrustSpawnRequest } from '../../shared/claude-folder-trust-spawn-request'
import { resolveClaudeWorktreeTrustTarget } from './claude-worktree-trust-eligibility'
import {
  applyClaudeWorktreeTrustToSpawn,
  resolveLocalClaudeTrustRequest
} from './claude-worktree-trust-spawn'

let root: string
let configDir: string
let configFile: string
let repoPath: string
let worktreePath: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-claude-trust-spawn-')))
  configDir = join(root, 'claude-config')
  mkdirSync(configDir)
  configFile = join(configDir, '.claude.json')
  writeFileSync(configFile, '{}', { mode: 0o600 })
  // Why: the writer merges process.env; pin every lookup to the temp dir so no test can reach a real config.
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  repoPath = join(root, 'repo')
  mkdirSync(repoPath)
  git(repoPath, 'init', '-q')
  git(
    repoPath,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'i'
  )
  worktreePath = join(root, 'wt')
  git(repoPath, 'worktree', 'add', '-q', worktreePath)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: repoPath,
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    ...overrides
  }
}

function orcaMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
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
    orcaCreationContentOrigin: 'repo-ref',
    ...overrides
  }
}

function store(args: { repo?: Repo; meta?: WorktreeMeta; enabled?: boolean } = {}) {
  const theRepo = args.repo ?? repo()
  return {
    getRepo: (id: string) => (id === theRepo.id ? theRepo : undefined),
    getWorktreeMeta: () => args.meta ?? orcaMeta(),
    getSettings: () => ({ claudeTrustOrcaWorktrees: args.enabled ?? true })
  }
}

function worktreeId(): string {
  return `repo-1::${worktreePath}`
}

function trustedKeys(): string[] {
  const projects = JSON.parse(readFileSync(configFile, 'utf-8')).projects ?? {}
  return Object.keys(projects).filter((key) => projects[key].hasTrustDialogAccepted === true)
}

async function spawn(
  overrides: Partial<Parameters<typeof applyClaudeWorktreeTrustToSpawn>[0]> = {}
): Promise<{ claudeFolderTrust?: ClaudeFolderTrustSpawnRequest }> {
  const spawnOptions: { claudeFolderTrust?: ClaudeFolderTrustSpawnRequest } = {}
  await applyClaudeWorktreeTrustToSpawn({
    store: store(),
    connectionId: null,
    worktreeId: worktreeId(),
    launchAgent: 'claude',
    command: 'claude',
    env: {},
    claudeAuth: null,
    wslDistro: null,
    isFreshLaunch: true,
    spawnOptions,
    ...overrides
  })
  return spawnOptions
}

describe('resolveClaudeWorktreeTrustTarget', () => {
  it('only claims worktrees Orca created in a git repo', () => {
    expect(resolveClaudeWorktreeTrustTarget(store(), worktreeId())?.trusted).toBe(true)
    expect(
      resolveClaudeWorktreeTrustTarget(
        store({ meta: orcaMeta({ orcaCreatedAt: undefined }) }),
        worktreeId()
      )
    ).toBeNull()
    expect(
      resolveClaudeWorktreeTrustTarget(store({ repo: repo({ kind: 'folder' }) }), worktreeId())
    ).toBeNull()
  })

  it('wants fork, unverified and pre-existing worktrees untrusted', () => {
    for (const origin of ['cross-repo-review-head', 'unverified-commit', undefined] as const) {
      expect(
        resolveClaudeWorktreeTrustTarget(
          store({ meta: orcaMeta({ orcaCreationContentOrigin: origin }) }),
          worktreeId()
        )?.trusted
      ).toBe(false)
    }
  })
})

describe('applyClaudeWorktreeTrustToSpawn', () => {
  it('trusts an Orca-created worktree for a local Claude launch', async () => {
    await spawn()
    expect(trustedKeys()).toEqual([worktreePath])
  })

  it('detects a Claude launch that setup sequencing rewrote', async () => {
    await spawn({
      launchAgent: undefined,
      command: `bash -lc 'eval "$ORCA_SEQUENCED_STARTUP_SCRIPT"'`,
      env: { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'claude --prefill hi' }
    })
    expect(trustedKeys()).toEqual([worktreePath])
  })

  it('leaves other agents, reattaches and folder workspaces alone', async () => {
    await spawn({ launchAgent: 'codex', command: 'codex' })
    await spawn({ isFreshLaunch: false })
    await spawn({ store: store({ repo: repo({ kind: 'folder' }) }) })
    expect(trustedKeys()).toEqual([])
  })

  it('does not trust a worktree created from a fork PR', async () => {
    await spawn({
      store: store({ meta: orcaMeta({ orcaCreationContentOrigin: 'cross-repo-review-head' }) })
    })
    expect(trustedKeys()).toEqual([])
  })

  it('revokes the entry it wrote once the setting is off', async () => {
    await spawn()
    await spawn({ store: store({ enabled: false }) })
    expect(trustedKeys()).toEqual([])
  })

  it('hands SSH launches to the relay instead of writing locally', async () => {
    const options = await spawn({ connectionId: 'ssh-1' })
    expect(options.claudeFolderTrust).toEqual({
      worktreeRoot: worktreePath,
      mainCheckoutPath: repoPath,
      trusted: true
    })
    expect(trustedKeys()).toEqual([])
  })
})

describe('resolveLocalClaudeTrustRequest for a WSL guest', () => {
  const target = {
    worktreeId: 'repo::wt',
    worktreeRoot: '//wsl.localhost/Ubuntu/home/dev/wt',
    mainCheckoutPath: '//wsl.localhost/Ubuntu/home/dev/repo',
    connectionId: null,
    trusted: true
  }
  const guestAuth = {
    configDir: '//wsl.localhost/Ubuntu/home/dev/.claude',
    runtime: 'wsl' as const,
    wslDistro: 'Ubuntu',
    wslLinuxConfigDir: '/home/dev/.claude',
    envPatch: {},
    stripAuthEnv: true,
    provenance: 'wsl:Ubuntu:system'
  }

  it("targets the guest's own config with Linux keys", () => {
    const request = resolveLocalClaudeTrustRequest(target, {}, guestAuth, 'Ubuntu')
    expect(request?.configFile).toBe(join('//wsl.localhost/Ubuntu/home/dev', '.claude.json'))
    expect(request?.keyStyle).toBe('posix')
    expect(request?.toClaudePath?.(target.worktreeRoot)).toBe('/home/dev/wt')
  })

  it("never writes the Windows host's config when the guest config dir is unknown", () => {
    const hostFallback = { ...guestAuth, configDir: join(root, '.claude'), wslLinuxConfigDir: null }
    expect(resolveLocalClaudeTrustRequest(target, {}, hostFallback, 'Ubuntu')).toBeNull()
    expect(resolveLocalClaudeTrustRequest(target, {}, null, 'Ubuntu')).toBeNull()
    // Agent Teams leaders and removal know neither the distro nor the guest auth.
    expect(resolveLocalClaudeTrustRequest(target, {}, null, null)).toBeNull()
  })
})
