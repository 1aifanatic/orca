import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readLinkChainFolders } from './codex-folder-watch'

describe.skipIf(process.platform === 'win32')('readLinkChainFolders', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-codex-link-chain-')))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function folder(...parts: string[]): string {
    const path = join(root, ...parts)
    mkdirSync(path, { recursive: true })
    return path
  }

  it("lists the standalone installer's layout: PATH entry, `current`, release", async () => {
    const release = folder('standalone', 'releases', '0.159.2', 'bin')
    writeFileSync(join(release, 'codex'), 'x')
    symlinkSync(
      join(root, 'standalone', 'releases', '0.159.2'),
      join(root, 'standalone', 'current')
    )
    const bin = folder('local', 'bin')
    symlinkSync(join(root, 'standalone', 'current', 'bin', 'codex'), join(bin, 'codex'))

    expect(await readLinkChainFolders(join(bin, 'codex'), 4)).toEqual([
      bin,
      join(root, 'standalone'),
      release
    ])
  })

  it("follows relative links, as npm's bin link is", async () => {
    const lib = folder('lib', 'codex', 'bin')
    writeFileSync(join(lib, 'codex.js'), 'x')
    const bin = folder('bin')
    symlinkSync('../lib/codex/bin/codex.js', join(bin, 'codex'))

    expect(await readLinkChainFolders(join(bin, 'codex'), 4)).toEqual([bin, lib])
  })

  it("keeps the real file's folder when the chain is longer than the cap", async () => {
    const real = folder('real')
    writeFileSync(join(real, 'codex'), 'x')
    let target = join(real, 'codex')
    for (const hop of ['a', 'b', 'c', 'd']) {
      symlinkSync(target, join(folder(hop), 'codex'))
      target = join(root, hop, 'codex')
    }

    expect(await readLinkChainFolders(target, 3)).toEqual([join(root, 'd'), join(root, 'c'), real])
  })

  it('ends on a link cycle, and lists a missing codex by its folder', async () => {
    const bin = folder('bin')
    symlinkSync(join(bin, 'loop-b'), join(bin, 'loop-a'))
    symlinkSync(join(bin, 'loop-a'), join(bin, 'loop-b'))

    await expect(readLinkChainFolders(join(bin, 'loop-a'), 4)).resolves.toContain(bin)
    expect(await readLinkChainFolders(join(bin, 'codex'), 4)).toEqual([bin])
  })
})
