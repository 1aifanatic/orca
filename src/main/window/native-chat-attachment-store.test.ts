import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import type { Store } from '../persistence'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import {
  getNativeChatAttachmentRoot,
  NATIVE_CHAT_ATTACHMENT_TTL_MS,
  saveNativeChatAttachmentFile,
  sweepExpiredNativeChatAttachments
} from './native-chat-attachment-store'

let userData: string

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'orca-chat-attachments-'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store reads only getPath.
  setAppEnvironment({ getPath: () => userData } as unknown as AppEnvironment)
})

afterEach(async () => {
  await rm(userData, { recursive: true, force: true })
})

describe('native chat attachment storage', () => {
  it('keeps each image in its own directory under user data', async () => {
    const saved = await saveNativeChatAttachmentFile('orca-paste-1.png', Buffer.from([7]))

    expect(dirname(dirname(saved))).toBe(getNativeChatAttachmentRoot())
    expect(getNativeChatAttachmentRoot().startsWith(userData)).toBe(true)
    expect(await readFile(saved)).toEqual(Buffer.from([7]))
  })

  // Nothing authorized it in this process: a relaunch forgets every per-file grant.
  it('lets a restored draft read its image with no grant from this session', async () => {
    const saved = await saveNativeChatAttachmentFile('orca-paste-1.png', Buffer.from([7]))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: with no repos and no workspace dir, authorization reads only these two.
    const store = { getRepos: () => [], getSettings: () => ({}) } as unknown as Store

    await expect(resolveAuthorizedPath(saved, store)).resolves.toBe(await realpath(saved))
  })

  it('sweeps pastes and drag copies past the age limit, and keeps younger ones', async () => {
    const old = await saveNativeChatAttachmentFile('orca-paste-old.png', Buffer.from([1]))
    const fresh = await saveNativeChatAttachmentFile('orca-paste-new.png', Buffer.from([2]))
    const oldDrop = join(getNativeChatAttachmentRoot(), 'orca-drop-abc123')
    await mkdir(oldDrop, { mode: 0o700 })
    const now = Date.now()
    const expired = new Date(now - NATIVE_CHAT_ATTACHMENT_TTL_MS - 1000)
    await utimes(dirname(old), expired, expired)
    await utimes(oldDrop, expired, expired)

    await sweepExpiredNativeChatAttachments(now)

    expect(await readdir(getNativeChatAttachmentRoot())).toEqual([basename(dirname(fresh))])
  })
})
