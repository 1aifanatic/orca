import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { probeCreateEventRepoFacts } from './create-event-repo-probe'

async function hookPresence(repoPath: string, platform: NodeJS.Platform): Promise<string> {
  return (await probeCreateEventRepoFacts(repoPath, platform)).postCheckoutHook
}

describe('probeCreateEventRepoFacts', () => {
  let repo: string

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'orca-hook-probe-'))
    await mkdir(path.join(repo, '.git', 'hooks'), { recursive: true })
    await writeFile(path.join(repo, '.git', 'config'), '[core]\n\tbare = false\n')
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  async function writeHook(mode: number): Promise<void> {
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout')
    await writeFile(hook, '#!/bin/sh\nexit 0\n')
    await chmod(hook, mode)
  }

  it('reports absent when only sample hooks exist', async () => {
    await writeFile(path.join(repo, '.git', 'hooks', 'post-checkout.sample'), '#!/bin/sh\n')
    expect(await hookPresence(repo, 'darwin')).toBe('absent')
  })

  it('reports present for an executable hook', async () => {
    await writeHook(0o755)
    expect(await hookPresence(repo, 'linux')).toBe('present')
  })

  it('reports absent for a hook Git would skip as non-executable', async () => {
    await writeHook(0o644)
    expect(await hookPresence(repo, 'linux')).toBe('absent')
  })

  it('reports present for any hook file on Windows', async () => {
    await writeHook(0o644)
    expect(await hookPresence(repo, 'win32')).toBe('present')
  })

  it('reports a configured hooks path without following it', async () => {
    await writeFile(path.join(repo, '.git', 'config'), '[core]\n\thooksPath = .husky/_\n')
    await writeHook(0o755)
    expect(await hookPresence(repo, 'linux')).toBe('custom_hooks_path')
  })

  it('reports neither fact when .git is a file it would need Git to resolve', async () => {
    await rm(path.join(repo, '.git'), { recursive: true })
    await writeFile(path.join(repo, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n')
    expect(await probeCreateEventRepoFacts(repo, 'linux')).toEqual({ postCheckoutHook: 'unknown' })
  })

  it('reports neither fact for a missing repo', async () => {
    expect(await probeCreateEventRepoFacts(path.join(repo, 'missing'), 'linux')).toEqual({
      postCheckoutHook: 'unknown'
    })
  })

  it('reports the index size alongside the hook', async () => {
    await writeFile(path.join(repo, '.git', 'index'), Buffer.alloc(4_096))
    expect(await probeCreateEventRepoFacts(repo, 'linux')).toEqual({
      postCheckoutHook: 'absent',
      indexBytes: 4_096
    })
  })

  it('omits the index size when the repo has no index yet', async () => {
    expect(await probeCreateEventRepoFacts(repo, 'linux')).toEqual({ postCheckoutHook: 'absent' })
  })

  it('still reports the index size when the config cannot be read', async () => {
    await rm(path.join(repo, '.git', 'config'))
    await writeFile(path.join(repo, '.git', 'index'), Buffer.alloc(10))
    expect(await probeCreateEventRepoFacts(repo, 'linux')).toEqual({
      postCheckoutHook: 'unknown',
      indexBytes: 10
    })
  })
})
