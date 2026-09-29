import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'node:os'
import type { AgentTrustPreset } from './agent-trust-presets'

const state = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: () => state.home }
})

import {
  applyWorkspaceTrustOnThisHost,
  type WorkspaceTrustHost
} from './execution-host-workspace-trust'

const PRESETS: readonly AgentTrustPreset[] = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'qoder',
  'antigravity'
]

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-host-trust-')))
  state.home = join(root, 'home', 'me')
  mkdirSync(state.home, { recursive: true })
  writeFileSync(join(state.home, '.claude.json'), '{}')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function thisHost(overrides: Partial<WorkspaceTrustHost> = {}): () => WorkspaceTrustHost {
  return () => ({
    homes: [state.home],
    claudeConfig: () => ({ configFile: join(state.home, '.claude.json'), keyStyle: 'posix' }),
    codexConfigFiles: () => [join(state.home, '.codex', 'config.toml')],
    deadlineMs: 1_500,
    ...overrides
  })
}

function trustWritten(preset: AgentTrustPreset): boolean {
  const home = state.home
  switch (preset) {
    case 'claude':
      return 'projects' in JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8'))
    case 'codex':
      return existsSync(join(home, '.codex', 'config.toml'))
    case 'cursor':
      return (
        existsSync(join(home, '.cursor', 'projects')) &&
        readdirSync(join(home, '.cursor', 'projects')).length > 0
      )
    case 'copilot':
      return existsSync(join(home, '.copilot', 'config.json'))
    case 'qoder':
      return existsSync(join(home, '.qoder', 'settings.json'))
    case 'antigravity':
      return existsSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'))
  }
}

/** A linked worktree at `worktree` whose main checkout is `mainCheckout`, as git lays it out. */
function linkWorktree(mainCheckout: string, worktree: string): void {
  const gitDir = join(mainCheckout, '.git', 'worktrees', 'feature')
  mkdirSync(gitDir, { recursive: true })
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`)
  writeFileSync(join(gitDir, 'gitdir'), join(worktree, '.git'))
}

describe('applyWorkspaceTrustOnThisHost', () => {
  it.each(PRESETS)('writes %s trust for an ordinary project folder', async (preset) => {
    const workspace = join(root, 'projects', 'app')
    mkdirSync(workspace, { recursive: true })
    await applyWorkspaceTrustOnThisHost(preset, workspace, thisHost())
    expect(trustWritten(preset)).toBe(true)
  })

  const tooBroad: [string, () => { workspace: string; homes?: string[] }][] = [
    ['the home', () => ({ workspace: state.home })],
    ['a folder containing the home', () => ({ workspace: join(root, 'home') })],
    ['a filesystem root', () => ({ workspace: '/' })],
    [
      'a symlink to the home',
      () => {
        symlinkSync(state.home, join(root, 'home-link'), 'junction')
        return { workspace: join(root, 'home-link') }
      }
    ],
    [
      'the home, when the host names it through a symlink',
      () => {
        symlinkSync(state.home, join(root, 'home-link'), 'junction')
        return { workspace: state.home, homes: [join(root, 'home-link')] }
      }
    ]
  ]
  describe.each(tooBroad)('for %s', (_label, arrange) => {
    it.each(PRESETS)('writes no %s trust', async (preset) => {
      const { workspace, homes } = arrange()
      await applyWorkspaceTrustOnThisHost(
        preset,
        workspace,
        thisHost(homes ? { homes } : undefined)
      )
      expect(trustWritten(preset)).toBe(false)
    })
  })

  it('never stores the home for Codex through a worktree whose main checkout is the home', async () => {
    const worktree = join(root, 'worktrees', 'feature')
    linkWorktree(state.home, worktree)
    await applyWorkspaceTrustOnThisHost('codex', worktree, thisHost())
    expect(trustWritten('codex')).toBe(false)
  })

  it.each(PRESETS.filter((preset) => preset !== 'codex'))(
    'still trusts that worktree itself for %s, which stores the worktree path',
    async (preset) => {
      const worktree = join(root, 'worktrees', 'feature')
      linkWorktree(state.home, worktree)
      await applyWorkspaceTrustOnThisHost(preset, worktree, thisHost())
      expect(trustWritten(preset)).toBe(true)
    }
  )

  it("trusts a worktree's main checkout for Codex when that checkout is not a home", async () => {
    const mainCheckout = join(root, 'repo')
    const worktree = join(root, 'worktrees', 'feature')
    linkWorktree(mainCheckout, worktree)
    await applyWorkspaceTrustOnThisHost('codex', worktree, thisHost())
    const written = readFileSync(join(state.home, '.codex', 'config.toml'), 'utf-8')
    expect(written).toContain(`[projects."${mainCheckout}"]`)
    expect(written).not.toContain(`[projects."${worktree}"]`)
  })

  it.each(PRESETS)('writes no %s trust when the host knows no home', async (preset) => {
    const workspace = join(root, 'projects', 'app')
    mkdirSync(workspace, { recursive: true })
    await applyWorkspaceTrustOnThisHost(
      preset,
      workspace,
      thisHost({ homes: [null, '', undefined] })
    )
    expect(trustWritten(preset)).toBe(false)
  })

  it('contains a host description or writer that throws, so the launch proceeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const workspace = join(root, 'projects', 'app')
    mkdirSync(workspace, { recursive: true })
    await expect(
      applyWorkspaceTrustOnThisHost('claude', workspace, () => {
        throw new Error('homedir unavailable')
      })
    ).resolves.toBeUndefined()
    await expect(
      applyWorkspaceTrustOnThisHost(
        'codex',
        workspace,
        thisHost({
          codexConfigFiles: () => {
            throw new Error('userData unavailable')
          }
        })
      )
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
