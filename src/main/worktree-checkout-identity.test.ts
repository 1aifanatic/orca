import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  matchCheckoutDirectory,
  readCheckoutDirectoryIdentity,
  type CheckoutDirectoryIdentity
} from './worktree-checkout-identity'

let directory = ''
let checkout = ''

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'orca-checkout-identity-')))
  checkout = join(directory, 'feature')
  await mkdir(checkout)
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function acceptedIdentity(): Promise<CheckoutDirectoryIdentity> {
  const identity = await readCheckoutDirectoryIdentity(checkout)
  expect(identity).toBeDefined()
  return identity ?? { dev: '', ino: '', birthtimeNs: '' }
}

describe('matching the checkout directory a removal accepted', () => {
  it('matches the same directory, whatever was deleted inside it', async () => {
    await writeFile(join(checkout, 'seed.txt'), 'seed\n')
    const identity = await acceptedIdentity()
    await rm(join(checkout, 'seed.txt'))

    expect(await matchCheckoutDirectory(checkout, identity)).toBe('same')
  })

  it('does not match a directory removed and created again at the same path', async () => {
    const identity = await acceptedIdentity()
    await rm(checkout, { recursive: true })
    await mkdir(checkout)
    await writeFile(join(checkout, 'notes.txt'), 'mine\n')

    expect(await matchCheckoutDirectory(checkout, identity)).toBe('different')
  })

  it('reports nothing at the path as absent, with or without an identity', async () => {
    const identity = await acceptedIdentity()
    await rm(checkout, { recursive: true })

    expect(await matchCheckoutDirectory(checkout, identity)).toBe('absent')
    expect(await matchCheckoutDirectory(checkout, undefined)).toBe('absent')
    expect(await readCheckoutDirectoryIdentity(checkout)).toBeUndefined()
  })

  it('reports a removal recorded without an identity as unrecorded', async () => {
    expect(await matchCheckoutDirectory(checkout, undefined)).toBe('unrecorded')
  })

  it('does not match a file put at the path', async () => {
    const identity = await acceptedIdentity()
    await rm(checkout, { recursive: true })
    await writeFile(checkout, 'mine\n')

    expect(await matchCheckoutDirectory(checkout, identity)).toBe('different')
    expect(await readCheckoutDirectoryIdentity(checkout)).toBeUndefined()
  })

  it('does not match a symlink at the path, even one to the accepted directory', async () => {
    const identity = await acceptedIdentity()
    const link = join(directory, 'link')
    // Junction on Windows: a directory symlink needs elevation there.
    await symlink(checkout, link, process.platform === 'win32' ? 'junction' : 'dir')

    // Followed, the link reaches the accepted directory, but what sits at the path is the link.
    expect(await matchCheckoutDirectory(link, identity)).toBe('different')
    expect(await readCheckoutDirectoryIdentity(link)).toBeUndefined()
  })

  it('never matches an identity recorded without a creation time', async () => {
    const identity = await acceptedIdentity()

    // Device and inode alone can name a different directory where inode numbers are reused.
    expect(await matchCheckoutDirectory(checkout, { ...identity, birthtimeNs: '0' })).toBe(
      'different'
    )
  })

  it('does not match the same device and inode with a different creation time', async () => {
    const identity = await acceptedIdentity()

    expect(
      await matchCheckoutDirectory(checkout, {
        ...identity,
        birthtimeNs: (BigInt(identity.birthtimeNs) + 1n).toString()
      })
    ).toBe('different')
  })
})
