import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ParsedTerminalFileLink } from '@/lib/terminal-links'
import type * as FileLinkTargetModule from '@/components/terminal-pane/terminal-file-link-target'
import type { FileLinkPathExistence } from '@/components/terminal-pane/terminal-file-link-target'
import { createNativeChatFileLinkExistence } from './native-chat-file-link-existence'

vi.mock('@/components/terminal-pane/terminal-file-link-target', async (importOriginal) => ({
  ...(await importOriginal<typeof FileLinkTargetModule>()),
  resolveFileLinkTarget: (link: ParsedTerminalFileLink) => ({
    absolutePath: `/repo/${link.pathText}`,
    line: null,
    column: null,
    fileContext: {},
    isRemoteRuntimePath: false,
    cacheKey: link.pathText,
    isKnownWorktreeRoot: link.pathText === 'ROOT'
  })
}))

const host = { cwd: '/repo', worktreeId: 'wt-1', worktreePath: '/repo' }

function link(pathText: string): ParsedTerminalFileLink {
  return {
    pathText,
    line: null,
    column: null,
    startIndex: 0,
    endIndex: pathText.length,
    displayText: pathText
  }
}

function hostWith(answer: (path: string) => boolean | Error) {
  const asked: string[] = []
  const pathExists = vi.fn<FileLinkPathExistence>(async (_context, path) => {
    asked.push(path)
    const result = answer(path)
    if (result instanceof Error) {
      throw result
    }
    return result
  })
  return { asked, pathExists }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createNativeChatFileLinkExistence', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('underlines a path only after the host confirms it, asking once', async () => {
    const { asked, pathExists } = hostWith((path) => path === '/repo/src/App.tsx')
    const existence = createNativeChatFileLinkExistence(host, pathExists)
    const watcher = existence.watch()
    const onChange = vi.fn()
    watcher.subscribe(onChange)

    expect(watcher.getSnapshot().check(link('src/App.tsx'))).toBe(false)
    expect(watcher.getSnapshot().check(link('src/App.tsx'))).toBe(false)
    await settle()

    expect(asked).toEqual(['/repo/src/App.tsx'])
    expect(onChange).toHaveBeenCalledOnce()
    expect(watcher.getSnapshot().check(link('src/App.tsx'))).toBe(true)
  })

  it('leaves a missing path plain without refreshing the message', async () => {
    const { pathExists } = hostWith(() => false)
    const existence = createNativeChatFileLinkExistence(host, pathExists)
    const watcher = existence.watch()
    const onChange = vi.fn()
    watcher.subscribe(onChange)

    watcher.getSnapshot().check(link('src/app.ts'))
    await settle()

    expect(onChange).not.toHaveBeenCalled()
    expect(watcher.getSnapshot().check(link('src/app.ts'))).toBe(false)
    expect(pathExists).toHaveBeenCalledOnce()
  })

  it('asks again about missing paths once a turn ends', async () => {
    let created = false
    const { asked, pathExists } = hostWith(() => created)
    const existence = createNativeChatFileLinkExistence(host, pathExists)
    const watcher = existence.watch()
    const onChange = vi.fn()
    watcher.subscribe(onChange)
    watcher.getSnapshot().check(link('src/new.ts'))
    await settle()

    created = true
    existence.forgetMissing()
    expect(onChange).toHaveBeenCalledOnce()
    watcher.getSnapshot().check(link('src/new.ts'))
    await settle()

    expect(asked).toEqual(['/repo/src/new.ts', '/repo/src/new.ts'])
    expect(watcher.getSnapshot().check(link('src/new.ts'))).toBe(true)
  })

  it('refreshes only the messages that named a confirmed path', async () => {
    const { pathExists } = hostWith(() => true)
    const existence = createNativeChatFileLinkExistence(host, pathExists)
    const naming = existence.watch()
    const other = existence.watch()
    const onNaming = vi.fn()
    const onOther = vi.fn()
    naming.subscribe(onNaming)
    other.subscribe(onOther)

    naming.getSnapshot().check(link('src/App.tsx'))
    await settle()

    expect(onNaming).toHaveBeenCalledOnce()
    expect(onOther).not.toHaveBeenCalled()
    expect(other.getSnapshot().check(link('src/App.tsx'))).toBe(true)
  })

  it('does not ask while text is still streaming in', async () => {
    const { pathExists } = hostWith(() => true)
    const existence = createNativeChatFileLinkExistence(host, pathExists)

    expect(existence.watch().getSnapshot().peek(link('src/Ap'))).toBe(false)
    await settle()

    expect(pathExists).not.toHaveBeenCalled()
  })

  it('treats a host that cannot answer as unknown, and waits before asking again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let reachable = false
    const { pathExists } = hostWith(() => (reachable ? true : new Error('SSH connection closed')))
    const existence = createNativeChatFileLinkExistence(host, pathExists)
    const snapshot = existence.watch().getSnapshot()

    snapshot.check(link('src/App.tsx'))
    await settle()
    snapshot.check(link('src/App.tsx'))
    await settle()
    expect(pathExists).toHaveBeenCalledOnce()

    reachable = true
    vi.setSystemTime(Date.now() + 15_000)
    snapshot.check(link('src/App.tsx'))
    await settle()

    expect(pathExists).toHaveBeenCalledTimes(2)
    expect(snapshot.check(link('src/App.tsx'))).toBe(true)
  })

  it('links a known workspace root without asking', () => {
    const { pathExists } = hostWith(() => false)
    const existence = createNativeChatFileLinkExistence(host, pathExists)

    expect(existence.watch().getSnapshot().check(link('ROOT'))).toBe(true)
    expect(pathExists).not.toHaveBeenCalled()
  })
})
