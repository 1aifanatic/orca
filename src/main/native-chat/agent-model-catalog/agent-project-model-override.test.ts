import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { workspaceMayOverrideDefaultModel } from './agent-project-model-override'

let root: string

function write(path: string, content = ''): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function mayOverride(agent: string, workspacePath: string, accountHomePath = '/homes/a') {
  return workspaceMayOverrideDefaultModel({ agent, workspacePath, accountHomePath })
}

describe('workspaceMayOverrideDefaultModel', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-project-model-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('finds a Codex project config at a linked worktree root', async () => {
    const worktree = join(root, 'wt')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    expect(await mayOverride('codex', worktree)).toBe(false)
    write(join(worktree, '.codex', 'config.toml'), 'model = "gpt-project"\n')
    expect(await mayOverride('codex', worktree)).toBe(true)
  })

  it('walks from a folder up to its repository root, and no further', async () => {
    const repo = join(root, 'repo')
    const folder = join(repo, 'packages', 'app')
    write(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(folder, { recursive: true })
    write(join(root, '.codex', 'config.toml'), 'model = "above-the-repo"\n')
    expect(await mayOverride('codex', folder)).toBe(false)
    write(join(repo, '.codex', 'config.toml'), 'model = "gpt-project"\n')
    expect(await mayOverride('codex', folder)).toBe(true)
  })

  it('reads only the folder itself when no repository contains it', async () => {
    const folder = join(root, 'loose')
    mkdirSync(folder, { recursive: true })
    write(join(root, '.codex', 'config.toml'), 'model = "parent"\n')
    expect(await mayOverride('codex', folder)).toBe(false)
  })

  it('skips the .codex directory that is the account home itself', async () => {
    const worktree = join(root, 'home-repo')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    write(join(worktree, '.codex', 'config.toml'), 'model = "user"\n')
    expect(await mayOverride('codex', worktree, join(worktree, '.codex'))).toBe(false)
  })

  it('finds a Claude project settings file, shared or local, but not the account home', async () => {
    const worktree = join(root, 'claude-repo')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    expect(await mayOverride('claude', worktree)).toBe(false)
    // The user's own `.claude` is account config, which the CLI's resolution already covers.
    write(join(worktree, '.claude', 'settings.json'), '{}')
    expect(await mayOverride('claude', worktree, join(worktree, '.claude'))).toBe(false)
    expect(await mayOverride('claude', worktree)).toBe(true)
    rmSync(join(worktree, '.claude', 'settings.json'))
    write(join(worktree, '.claude', 'settings.local.json'), '{}')
    expect(await mayOverride('claude', worktree)).toBe(true)
  })

  it('never vouches for an agent whose project config it does not know', async () => {
    expect(await mayOverride('opencode', join(root, 'anywhere'))).toBe(true)
  })
})
