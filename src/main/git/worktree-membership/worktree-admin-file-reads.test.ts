// The membership model and the head-identity reader share one set of admin-file rules; these
// fixtures pin that they read the same HEAD the same way.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readGitCommonHeadIdentities } from '../../ipc/worktree-head-identity-reader'
import { FULL_MEMBERSHIP_SCOPE } from './worktree-membership-model'
import { validateMembershipFromFiles } from './worktree-membership-file-validation'

const OID_MAIN = 'a'.repeat(40)
const OID_PACKED = 'b'.repeat(40)
const OID_DETACHED = 'c'.repeat(40)

let root = ''
let commonDir = ''

async function writeAdminFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function addLinked(name: string, head: string): Promise<string> {
  const worktreePath = join(root, `wt-${name}`)
  const entry = join(commonDir, 'worktrees', name)
  await writeAdminFile(join(entry, 'HEAD'), `${head}\n`)
  await writeAdminFile(join(entry, 'gitdir'), `${worktreePath}/.git\n`)
  await writeAdminFile(join(worktreePath, '.git'), `gitdir: ${entry}\n`)
  return worktreePath
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-admin-file-reads-')))
  commonDir = join(root, 'checkout', '.git')
  await writeAdminFile(join(commonDir, 'HEAD'), 'ref: refs/heads/main\n')
  await writeAdminFile(join(commonDir, 'refs', 'heads', 'main'), `${OID_MAIN}\n`)
  // A symref chain: `alias` is itself a symref to `main`.
  await writeAdminFile(join(commonDir, 'refs', 'heads', 'alias'), 'ref: refs/heads/main\n')
  await writeAdminFile(
    join(commonDir, 'packed-refs'),
    `# pack-refs with: peeled fully-peeled sorted\n${OID_PACKED} refs/heads/packed-only\n`
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('shared admin-file rules', () => {
  it('give the head-identity reader and the membership model the same heads', async () => {
    const chain = await addLinked('chain', 'ref: refs/heads/alias')
    const packed = await addLinked('packed', 'ref: refs/heads/packed-only')
    const detached = await addLinked('detached', OID_DETACHED)

    const { identities, complete } = await readGitCommonHeadIdentities(commonDir)
    const { rows } = await validateMembershipFromFiles({
      commonDir,
      main: { path: dirname(commonDir), isBare: false },
      previous: null,
      dirty: FULL_MEMBERSHIP_SCOPE,
      full: true
    })

    expect(complete).toBe(true)
    expect(identities).toHaveLength(4)
    for (const identity of identities) {
      const row = rows.find((candidate) => candidate.path === identity.worktreePath)
      expect(row, identity.worktreePath).toBeDefined()
      expect({ head: row?.head, branch: row?.branch || null }).toEqual({
        head: identity.head,
        branch: identity.branch
      })
    }
    expect(rows.map((row) => row.path)).toEqual([dirname(commonDir), chain, detached, packed])
  })

  it('reports the branch a symref chain ends at, as Git does', async () => {
    const chain = await addLinked('chain', 'ref: refs/heads/alias')

    const { identities } = await readGitCommonHeadIdentities(commonDir)

    expect(identities.find((identity) => identity.worktreePath === chain)).toEqual({
      worktreePath: chain,
      head: OID_MAIN,
      branch: 'refs/heads/main'
    })
  })
})
