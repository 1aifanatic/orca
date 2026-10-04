import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../shared/agent-session-host-authority'

const { authorizeExternalPathMock } = vi.hoisted(() => ({ authorizeExternalPathMock: vi.fn() }))
vi.mock('../ipc/filesystem-auth', () => ({ authorizeExternalPath: authorizeExternalPathMock }))

import {
  NATIVE_CHAT_PASTE_TTL_MS,
  isInsideNativeChatPasteFolder,
  restoreNativeChatPastes,
  sweepExpiredNativeChatPastes
} from './native-chat-paste-files'

describe('isInsideNativeChatPasteFolder', () => {
  const posixFolder = '/data/native-chat-pastes'
  const winFolder = 'C:\\Users\\Me\\AppData\\Roaming\\Orca\\native-chat-pastes'

  it.each([
    ['a file inside', `${posixFolder}/orca-paste-1.png`, true],
    ['a name that only starts with dots', `${posixFolder}/..orca-paste-1.png`, true],
    ['the folder itself', posixFolder, false],
    ['the parent', '/data', false],
    ['a sibling reached through ..', `${posixFolder}/../secret.png`, false],
    ['a sibling folder sharing the prefix', '/data/native-chat-pastes-evil/x.png', false],
    ['an unrelated absolute path', '/etc/passwd', false]
  ])('posix: %s', (_label, target, inside) => {
    expect(isInsideNativeChatPasteFolder(posixFolder, target, path.posix, 'darwin')).toBe(inside)
  })

  it.each([
    ['a file inside', `${winFolder}\\orca-paste-1.png`, true],
    ['a file inside in other letter case', `${winFolder.toLowerCase()}\\ORCA-PASTE-1.PNG`, true],
    ['a \\\\?\\ prefixed file inside', `\\\\?\\${winFolder}\\orca-paste-1.png`, true],
    ['another drive', 'D:\\native-chat-pastes\\orca-paste-1.png', false],
    ['a \\\\?\\UNC share', '\\\\?\\UNC\\server\\share\\orca-paste-1.png', false],
    ['a sibling reached through ..', `${winFolder}\\..\\secret.png`, false],
    ['the folder itself', winFolder, false]
  ])('win32: %s', (_label, target, inside) => {
    expect(isInsideNativeChatPasteFolder(winFolder, target, path.win32, 'win32')).toBe(inside)
  })

  it('compares a \\\\?\\ prefixed folder like its plain form', () => {
    expect(
      isInsideNativeChatPasteFolder(
        `\\\\?\\${winFolder}`,
        `${winFolder}\\orca-paste-1.png`,
        path.win32,
        'win32'
      )
    ).toBe(true)
  })
})

describe('native-chat paste folder on disk', () => {
  let root: string
  let folder: string

  beforeEach(() => {
    authorizeExternalPathMock.mockReset()
    root = mkdtempSync(path.join(tmpdir(), 'orca-native-chat-pastes-'))
    folder = path.join(root, 'native-chat-pastes')
    mkdirSync(folder)
    installFakeAppEnvironment({ getPath: () => root })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('re-grants only files really inside the folder, and never throws on a bad path', async () => {
    const kept = path.join(folder, 'orca-paste-1.png')
    writeFileSync(kept, 'png')
    const outside = path.join(root, 'outside.png')
    writeFileSync(outside, 'png')
    const linkOut = path.join(folder, 'orca-paste-2.png')
    symlinkSync(outside, linkOut)
    mkdirSync(path.join(folder, 'orca-paste-dir.png'))

    const results = await restoreNativeChatPastes([
      kept,
      linkOut,
      path.join(folder, '..', 'outside.png'),
      path.join(folder, 'orca-paste-dir.png'),
      path.join(folder, 'orca-paste-missing.png'),
      'relative/orca-paste-3.png',
      '',
      42
    ])

    expect(results).toEqual([
      { path: kept, kept: true, exists: true },
      { path: linkOut, kept: false, exists: false },
      { path: path.join(folder, '..', 'outside.png'), kept: false, exists: false },
      { path: path.join(folder, 'orca-paste-dir.png'), kept: false, exists: false },
      { path: path.join(folder, 'orca-paste-missing.png'), kept: false, exists: false },
      { path: 'relative/orca-paste-3.png', kept: false, exists: false },
      { path: '', kept: false, exists: false }
    ])
    const granted = authorizeExternalPathMock.mock.calls.map(([granted]) => granted)
    expect(granted).toContain(realpathSync(kept))
    expect(granted.some((value: string) => value.includes('outside'))).toBe(false)
    await expect(restoreNativeChatPastes('not a list')).resolves.toEqual([])
  })

  it('keeps a paste reached through a symlinked alias of the folder, as /var is of /private/var', async () => {
    const kept = path.join(folder, 'orca-paste-1.png')
    writeFileSync(kept, 'png')
    const alias = path.join(tmpdir(), `orca-native-chat-pastes-alias-${process.pid}`)
    rmSync(alias, { force: true })
    symlinkSync(root, alias)
    try {
      installFakeAppEnvironment({ getPath: () => alias })
      const viaAlias = path.join(alias, 'native-chat-pastes', 'orca-paste-1.png')

      await expect(restoreNativeChatPastes([viaAlias, kept])).resolves.toEqual([
        { path: viaAlias, kept: true, exists: true },
        { path: kept, kept: true, exists: true }
      ])
    } finally {
      rmSync(alias, { force: true })
    }
  })

  it('reports nothing kept when the folder does not exist yet', async () => {
    rmSync(folder, { recursive: true })
    await expect(restoreNativeChatPastes([path.join(folder, 'orca-paste-1.png')])).resolves.toEqual(
      [{ path: path.join(folder, 'orca-paste-1.png'), kept: false, exists: false }]
    )
  })

  it('expires old pastes only, and never follows a symlink or enters a folder', async () => {
    const now = Date.now()
    const old = (now - NATIVE_CHAT_PASTE_TTL_MS - 60_000) / 1000
    const oldPaste = path.join(folder, 'orca-paste-old.png')
    const newPaste = path.join(folder, 'orca-paste-new.png')
    writeFileSync(oldPaste, 'png')
    writeFileSync(newPaste, 'png')
    utimesSync(oldPaste, old, old)
    const outsideOld = path.join(root, 'outside-old.png')
    writeFileSync(outsideOld, 'png')
    utimesSync(outsideOld, old, old)
    symlinkSync(outsideOld, path.join(folder, 'orca-paste-link.png'))
    lutimesSync(path.join(folder, 'orca-paste-link.png'), old, old)
    const nested = path.join(folder, 'nested')
    mkdirSync(nested)
    const nestedOld = path.join(nested, 'orca-paste-nested.png')
    writeFileSync(nestedOld, 'png')
    utimesSync(nestedOld, old, old)

    await sweepExpiredNativeChatPastes(now)

    expect(existsSync(oldPaste)).toBe(false)
    expect(existsSync(newPaste)).toBe(true)
    expect(existsSync(outsideOld)).toBe(true)
    expect(existsSync(path.join(folder, 'orca-paste-link.png'))).toBe(true)
    expect(existsSync(nestedOld)).toBe(true)
  })

  it('does nothing, and does not throw, when the folder is missing', async () => {
    rmSync(folder, { recursive: true })
    await expect(sweepExpiredNativeChatPastes()).resolves.toBeUndefined()
  })

  it('keeps pastes longer than the host keeps a resend admissible', () => {
    expect(NATIVE_CHAT_PASTE_TTL_MS).toBeGreaterThan(AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS)
  })
})
