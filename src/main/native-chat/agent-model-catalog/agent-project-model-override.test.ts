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
    write(join(worktree, '.claude', 'settings.json'), '{"model":"sonnet"}')
    expect(await mayOverride('claude', worktree, join(worktree, '.claude'))).toBe(false)
    expect(await mayOverride('claude', worktree)).toBe(true)
    rmSync(join(worktree, '.claude', 'settings.json'))
    write(join(worktree, '.claude', 'settings.local.json'), '{"effortLevel":"low"}')
    expect(await mayOverride('claude', worktree)).toBe(true)
  })

  it('ignores Claude project settings that pick no model or effort', async () => {
    const worktree = join(root, 'claude-permissions')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    // A committed permissions/hooks file, and the local file "always allow" writes.
    write(
      join(worktree, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(pnpm test)'] }, hooks: {}, env: { CI: '1' } })
    )
    write(
      join(worktree, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['WebFetch'] } })
    )
    expect(await mayOverride('claude', worktree)).toBe(false)
  })

  it.each([
    ['a model', { model: 'opus' }],
    ['a per-model effort', { modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }],
    ['the model env var', { env: { ANTHROPIC_MODEL: 'claude-sonnet-5' } }],
    ['an alias target', { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5' } }],
    ['the effort env var', { env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } }],
    ['another provider', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }]
  ])('counts Claude project settings that set %s', async (_name, settings) => {
    const worktree = join(root, 'claude-model')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    write(join(worktree, '.claude', 'settings.json'), JSON.stringify(settings))
    expect(await mayOverride('claude', worktree)).toBe(true)
  })

  it('counts unreadable project config as an override', async () => {
    const worktree = join(root, 'broken')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    write(join(worktree, '.claude', 'settings.json'), '{ "model": ')
    write(join(worktree, '.codex', 'config.toml'), 'model = ')
    expect(await mayOverride('claude', worktree)).toBe(true)
    expect(await mayOverride('codex', worktree)).toBe(true)
  })

  it('ignores Codex project config that picks no model, effort or profile', async () => {
    const worktree = join(root, 'codex-mcp')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    write(join(worktree, '.codex', 'config.toml'), '[mcp_servers.docs]\ncommand = "docs-mcp"\n')
    expect(await mayOverride('codex', worktree)).toBe(false)
    write(
      join(worktree, '.codex', 'config.toml'),
      '[profiles.deep]\nmodel_reasoning_effort = "xhigh"\n'
    )
    expect(await mayOverride('codex', worktree)).toBe(true)
    write(join(worktree, '.codex', 'config.toml'), 'profile = "deep"\n')
    expect(await mayOverride('codex', worktree)).toBe(true)
  })

  it('never vouches for an agent whose project config it does not know', async () => {
    expect(await mayOverride('opencode', join(root, 'anywhere'))).toBe(true)
  })
})
