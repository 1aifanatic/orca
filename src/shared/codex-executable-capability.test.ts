import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexExecutableCapability } from './codex-executable-capability'
import { codexSupportsNoDaemon } from './codex-terminal-launch-policy'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function binary(content = Buffer.from('7f454c460000', 'hex')) {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-capability-'))
  roots.push(root)
  const path = join(root, 'codex')
  await writeFile(path, content)
  return path
}

describe('Codex terminal execution capability', () => {
  it.each(['codex-cli 0.156.0', 'codex-cli 0.157.1', 'codex-cli 0.158.0'])(
    'accepts released support: %s',
    (output) => {
      expect(codexSupportsNoDaemon(output)).toBe(true)
    }
  )
  it.each([
    'codex-cli 0.155.0',
    '',
    '0.157.0',
    'codex-cli 0.156.0-alpha.1',
    'error: codex-cli 0.157.0'
  ])('keeps old or unproven launches unchanged: %s', (output) => {
    expect(codexSupportsNoDaemon(output)).toBe(false)
  })
  it('shares concurrent probes and rechecks a replaced executable', async () => {
    const path = await binary()
    const probe = vi.fn(async () => 'codex-cli 0.156.0')
    const cache = new CodexExecutableCapability(probe)
    expect(await Promise.all([cache.supportsNoDaemon(path), cache.supportsNoDaemon(path)])).toEqual(
      [true, true]
    )
    expect(probe).toHaveBeenCalledTimes(1)
    expect(await cache.supportsNoDaemon(path)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
    probe.mockResolvedValue('codex-cli 0.155.0')
    await writeFile(path, Buffer.from('7f454c460000000000', 'hex'))
    expect(await cache.supportsNoDaemon(path)).toBe(false)
    expect(probe).toHaveBeenCalledTimes(2)
  })
  it.skipIf(process.platform === 'win32')(
    'invalidates a launcher symlink that selects a different binary',
    async () => {
      const first = await binary()
      const second = await binary()
      const link = `${first}-link`
      await symlink(first, link)
      const canonicalFirst = await realpath(first)
      const probe = vi.fn(async (path: string) =>
        path === canonicalFirst ? 'codex-cli 0.156.0' : 'codex-cli 0.155.0'
      )
      const cache = new CodexExecutableCapability(probe)
      expect(await cache.supportsNoDaemon(link)).toBe(true)
      await rm(link)
      await symlink(second, link)
      expect(await cache.supportsNoDaemon(link)).toBe(false)
      expect(probe).toHaveBeenCalledTimes(2)
    }
  )
  it('does not retain script evidence across changes to the executable it delegates to', async () => {
    const path = await binary(Buffer.from('#!/bin/sh\nexec other-codex "$@"'))
    const probe = vi.fn(async () => 'codex-cli 0.156.0')
    const cache = new CodexExecutableCapability(probe)
    expect(await cache.supportsNoDaemon(path)).toBe(true)
    probe.mockResolvedValue('codex-cli 0.155.0')
    expect(await cache.supportsNoDaemon(path)).toBe(false)
  })
  it('does not share evidence between execution hosts or paths', async () => {
    const path = await binary()
    const otherPath = await binary()
    const probe = vi.fn(async () => 'codex-cli 0.156.0')
    const local = new CodexExecutableCapability(probe)
    const remote = new CodexExecutableCapability(async () => 'codex-cli 0.155.0')
    expect(await local.supportsNoDaemon(path)).toBe(true)
    expect(await remote.supportsNoDaemon(path)).toBe(false)
    expect(await local.supportsNoDaemon(otherPath)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
  })
  it('discards evidence when the binary changes during the probe', async () => {
    const path = await binary()
    const cache = new CodexExecutableCapability(async () => {
      await writeFile(path, 'replaced')
      return 'codex-cli 0.156.0'
    })
    expect(await cache.supportsNoDaemon(path)).toBe(false)
  })
  it('makes failed probes non-fatal', async () => {
    const cache = new CodexExecutableCapability(async () => {
      throw new Error('unavailable')
    })
    expect(await cache.supportsNoDaemon(await binary())).toBe(false)
    expect(await cache.supportsNoDaemon('/missing/codex')).toBe(false)
  })
})
