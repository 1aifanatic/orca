import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { probePostCheckoutHookPresence } from './post-checkout-hook-presence'

describe('probePostCheckoutHookPresence', () => {
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
    expect(await probePostCheckoutHookPresence(repo, 'darwin')).toBe('absent')
  })

  it('reports present for an executable hook', async () => {
    await writeHook(0o755)
    expect(await probePostCheckoutHookPresence(repo, 'linux')).toBe('present')
  })

  it('reports absent for a hook Git would skip as non-executable', async () => {
    await writeHook(0o644)
    expect(await probePostCheckoutHookPresence(repo, 'linux')).toBe('absent')
  })

  it('reports present for any hook file on Windows', async () => {
    await writeHook(0o644)
    expect(await probePostCheckoutHookPresence(repo, 'win32')).toBe('present')
  })

  it('reports a configured hooks path without following it', async () => {
    await writeFile(path.join(repo, '.git', 'config'), '[core]\n\thooksPath = .husky/_\n')
    await writeHook(0o755)
    expect(await probePostCheckoutHookPresence(repo, 'linux')).toBe('custom_hooks_path')
  })

  it('reports unknown when .git is a file it would need Git to resolve', async () => {
    await rm(path.join(repo, '.git'), { recursive: true })
    await writeFile(path.join(repo, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n')
    expect(await probePostCheckoutHookPresence(repo, 'linux')).toBe('unknown')
  })

  it('reports unknown for a missing repo', async () => {
    expect(await probePostCheckoutHookPresence(path.join(repo, 'missing'), 'linux')).toBe('unknown')
  })
})
