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

  async function writeIndex(signature: string, version: number, entries: number): Promise<void> {
    const header = Buffer.alloc(12)
    header.write(signature, 0, 'latin1')
    header.writeUInt32BE(version, 4)
    header.writeUInt32BE(entries, 8)
    await writeFile(path.join(repo, '.git', 'index'), Buffer.concat([header, Buffer.alloc(64)]))
  }

  it.each([2, 4])(
    'reads the tracked-file count from a version %i index header',
    async (version) => {
      await writeIndex('DIRC', version, 123_456)
      expect(await probeCreateEventRepoFacts(repo, 'linux')).toEqual({
        postCheckoutHook: 'absent',
        indexEntryCount: 123_456
      })
    }
  )

  it('omits the count when the repo has no index yet', async () => {
    expect(await probeCreateEventRepoFacts(repo, 'linux')).toEqual({ postCheckoutHook: 'absent' })
  })

  it('omits the count for a file that is not an index', async () => {
    await writeIndex('NOPE', 2, 10)
    expect(await probeCreateEventRepoFacts(repo, 'linux')).not.toHaveProperty('indexEntryCount')
  })

  it('omits the count for a truncated index', async () => {
    await writeFile(path.join(repo, '.git', 'index'), Buffer.from('DIRC\0\0'))
    expect(await probeCreateEventRepoFacts(repo, 'linux')).not.toHaveProperty('indexEntryCount')
  })

  it('omits the count for a split index, whose entries live in a shared index', async () => {
    await writeIndex('DIRC', 2, 3)
    await writeFile(path.join(repo, '.git', 'sharedindex.0123abcd'), '')
    expect(await probeCreateEventRepoFacts(repo, 'linux')).not.toHaveProperty('indexEntryCount')
  })

  it('omits the count for a sparse index, which collapses directories', async () => {
    await writeIndex('DIRC', 4, 3)
    await writeFile(path.join(repo, '.git', 'config'), '[index]\n\tsparse = true\n')
    expect(await probeCreateEventRepoFacts(repo, 'linux')).not.toHaveProperty('indexEntryCount')
  })

  it.each([
    '[index]\n\tsparse = true\n',
    '[index]\n\tsparse = YES\n',
    '[index]\n\tsparse\n',
    '[core]\n\tsparseCheckout = 1\n'
  ])(
    'omits the count when config.worktree turns sparse checkout on (%j)',
    async (worktreeConfig) => {
      await writeIndex('DIRC', 4, 7)
      await writeFile(path.join(repo, '.git', 'config.worktree'), worktreeConfig)
      expect(await probeCreateEventRepoFacts(repo, 'linux')).not.toHaveProperty('indexEntryCount')
    }
  )

  it('keeps the count when sparse checkout is explicitly off', async () => {
    await writeIndex('DIRC', 2, 11)
    await writeFile(
      path.join(repo, '.git', 'config'),
      '[core]\n\tsparseCheckout = false\n\tsparseCheckoutCone = true\n[index]\n\tsparse = off\n'
    )
    expect(await probeCreateEventRepoFacts(repo, 'linux')).toMatchObject({ indexEntryCount: 11 })
  })

  it('reports a hooks path set in config.worktree', async () => {
    await writeFile(path.join(repo, '.git', 'config.worktree'), '[core]\n\thooksPath = .githooks\n')
    await writeHook(0o755)
    expect(await hookPresence(repo, 'linux')).toBe('custom_hooks_path')
  })

  it('reports neither fact when the config cannot be read', async () => {
    await rm(path.join(repo, '.git', 'config'))
    await writeIndex('DIRC', 2, 10)
    expect(await probeCreateEventRepoFacts(repo, 'linux')).toEqual({ postCheckoutHook: 'unknown' })
  })
})
