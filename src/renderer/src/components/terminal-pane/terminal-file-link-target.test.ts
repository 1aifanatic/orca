import { describe, expect, it, vi } from 'vitest'
import { extractTerminalFileLinks } from '@/lib/terminal-links'
import type * as FileOpenRoutingModule from './terminal-file-open-routing'
import {
  mayCheckFileLinkTargetUnprompted,
  resolveFileLinkTarget,
  type FileLinkHost
} from './terminal-file-link-target'

const routing = vi.hoisted(() => {
  const state: { connectionId?: string } = {}
  return state
})

vi.mock('./terminal-file-open-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof FileOpenRoutingModule>()),
  getTerminalFileContext: (worktreeId: string, worktreePath: string) => ({
    settings: null,
    worktreeId,
    worktreePath,
    connectionId: routing.connectionId
  })
}))
vi.mock('./terminal-worktree-path-link', () => ({
  resolveKnownWorktreeRootPathLink: () => null
}))

function mayCheck(pathText: string, workspace: string): boolean {
  const link = extractTerminalFileLinks(pathText).find(
    (candidate) => candidate.startIndex === 0 && candidate.endIndex === pathText.length
  )
  const host: FileLinkHost = { cwd: workspace, worktreeId: 'wt-1', worktreePath: workspace }
  const target = link ? resolveFileLinkTarget(link, host) : null
  if (!target) {
    throw new Error(`no target for ${pathText}`)
  }
  return mayCheckFileLinkTargetUnprompted(target, host)
}

describe('mayCheckFileLinkTargetUnprompted', () => {
  it('refuses a local check of a network share outside the workspace', () => {
    for (const workspace of [String.raw`C:\Users\me\repo`, '/Users/me/repo']) {
      expect(mayCheck(String.raw`\\evil.example\share\a.ts`, workspace)).toBe(false)
      expect(mayCheck('//evil.example/share/notes.md', workspace)).toBe(false)
    }
  })

  it('allows workspace paths, WSL paths and checks another host makes', () => {
    expect(mayCheck('src/a.ts', String.raw`C:\Users\me\repo`)).toBe(true)
    expect(mayCheck('src/a.ts', String.raw`\\FileServer\share\repo`)).toBe(true)
    expect(
      mayCheck(String.raw`\\FILESERVER\Share\repo\src\a.ts`, String.raw`\\fileserver\share\repo`)
    ).toBe(true)
    expect(mayCheck('/home/me/repo/a.ts', String.raw`\\wsl.localhost\Ubuntu\home\me\repo`)).toBe(
      true
    )
    expect(
      mayCheck(String.raw`\\wsl.localhost\Debian\etc\hosts.txt`, String.raw`C:\Users\me\repo`)
    ).toBe(true)

    routing.connectionId = 'ssh-1'
    try {
      expect(mayCheck('//evil.example/share/notes.md', '/home/me/repo')).toBe(true)
    } finally {
      routing.connectionId = undefined
    }
  })
})
