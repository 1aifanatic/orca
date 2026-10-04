// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type * as AttachmentUploadModule from './native-chat-attachment-upload'

const mocks = vi.hoisted(() => ({
  authorizeExternalPath: vi.fn(),
  resolveNativeChatAttachmentOwner: vi.fn(),
  resolveNativeChatAttachmentOwnerForWorktree: vi.fn(),
  uploadNativeChatAttachmentPaths: vi.fn(),
  prepareNativeChatSessionAttachmentUpload: vi.fn(),
  uploadNativeChatSessionAttachmentPaths: vi.fn(),
  toastLoading: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { loading: mocks.toastLoading, dismiss: vi.fn(), error: vi.fn(), message: vi.fn() }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({}) }
}))

// Real notice strings, so the tests below assert what a user would actually read
// and a newly added notice cannot go missing from this mock.
vi.mock('./native-chat-attachment-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof AttachmentUploadModule>()),
  resolveNativeChatAttachmentOwner: mocks.resolveNativeChatAttachmentOwner,
  resolveNativeChatAttachmentOwnerForWorktree: mocks.resolveNativeChatAttachmentOwnerForWorktree,
  uploadNativeChatAttachmentPaths: mocks.uploadNativeChatAttachmentPaths,
  prepareNativeChatSessionAttachmentUpload: mocks.prepareNativeChatSessionAttachmentUpload,
  uploadNativeChatSessionAttachmentPaths: mocks.uploadNativeChatSessionAttachmentPaths
}))

import { useNativeChatExternalAttachments } from './use-native-chat-external-attachments'
import type { NativeChatPendingAttachmentChips } from './native-chat-session-attachment-drop'
import type { AgentSessionAttachmentPathUploadResult } from '../../../../shared/agent-session-attachments'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'

type HookApi = ReturnType<typeof useNativeChatExternalAttachments>

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function noPendingChips(): NativeChatPendingAttachmentChips {
  return { begin: vi.fn(() => null), resolve: vi.fn(), drop: vi.fn(() => true) }
}

function Probe({
  disabled,
  structuredWorktreeId,
  structuredSession,
  attachResolvedPaths,
  pendingChips,
  setNotice,
  onReady
}: {
  disabled: boolean
  structuredWorktreeId?: string
  structuredSession?: { sessionId: string; runtimeEnvironmentId: string | null }
  attachResolvedPaths: (paths: string[]) => void
  pendingChips: NativeChatPendingAttachmentChips
  setNotice: (notice: string | null) => void
  onReady: (api: HookApi) => void
}): null {
  onReady(
    useNativeChatExternalAttachments({
      terminalTabId: 'tab-1',
      structuredWorktreeId,
      structuredSession,
      disabled,
      attachResolvedPaths,
      pendingChips,
      setNotice
    })
  )
  return null
}

let root: Root | null = null

async function renderProbe(args: {
  disabled?: boolean
  structuredWorktreeId?: string
  structuredSession?: { sessionId: string; runtimeEnvironmentId: string | null }
  attachResolvedPaths: (paths: string[]) => void
  pendingChips?: NativeChatPendingAttachmentChips
  setNotice?: (notice: string | null) => void
}): Promise<{
  latest: () => HookApi
  setDisabled: (disabled: boolean) => Promise<void>
  setStructuredWorktreeId: (structuredWorktreeId: string) => Promise<void>
}> {
  const container = document.createElement('div')
  document.body.append(container)
  let api: HookApi | null = null
  root = createRoot(container)
  let disabled = args.disabled ?? false
  let structuredWorktreeId = args.structuredWorktreeId
  const render = async (): Promise<void> => {
    await act(async () => {
      root?.render(
        createElement(Probe, {
          disabled,
          structuredWorktreeId,
          structuredSession: args.structuredSession,
          attachResolvedPaths: args.attachResolvedPaths,
          pendingChips: args.pendingChips ?? noPendingChips(),
          setNotice: args.setNotice ?? (() => {}),
          onReady: (next) => {
            api = next
          }
        })
      )
    })
  }
  await render()
  return {
    latest: () => {
      if (!api) {
        throw new Error('Probe did not render')
      }
      return api
    },
    setDisabled: async (next) => {
      disabled = next
      await render()
    },
    setStructuredWorktreeId: async (next) => {
      structuredWorktreeId = next
      await render()
    }
  }
}

beforeEach(() => {
  mocks.authorizeExternalPath.mockReset().mockResolvedValue(undefined)
  mocks.resolveNativeChatAttachmentOwnerForWorktree.mockReset().mockReturnValue({ kind: 'local' })
  window.api = {
    fs: { authorizeExternalPath: mocks.authorizeExternalPath }
  } as unknown as Window['api']
})

afterEach(() => {
  root?.unmount()
  root = null
  vi.clearAllMocks()
})

describe('useNativeChatExternalAttachments', () => {
  it('attaches local worktree paths unchanged', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'local' })
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })
    await act(async () => {
      probe.latest().attachExternalPaths(['/local/a.txt'])
    })
    expect(mocks.authorizeExternalPath).toHaveBeenCalledExactlyOnceWith({
      targetPath: '/local/a.txt'
    })
    expect(attachResolvedPaths).toHaveBeenCalledWith(['/local/a.txt'])
    expect(mocks.uploadNativeChatAttachmentPaths).not.toHaveBeenCalled()
  })

  it('waits for local authorization and skips rejected paths without blocking other files', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'local' })
    const authorization = deferred<void>()
    mocks.authorizeExternalPath
      .mockReturnValueOnce(authorization.promise)
      .mockRejectedValueOnce(new Error('denied'))
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })
    act(() =>
      probe.latest().attachExternalPaths(['/external/a.png', '/external/b.png', '/external/c.png'])
    )
    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(mocks.authorizeExternalPath).toHaveBeenCalledTimes(1)
    await act(async () => authorization.resolve())
    expect(attachResolvedPaths).toHaveBeenCalledExactlyOnceWith([
      '/external/a.png',
      '/external/c.png'
    ])
    expect(mocks.authorizeExternalPath).toHaveBeenCalledTimes(3)
  })

  it('does not attach local paths when disabled during authorization', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'local' })
    const authorization = deferred<void>()
    mocks.authorizeExternalPath.mockReturnValueOnce(authorization.promise)
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })
    act(() => probe.latest().attachExternalPaths(['/external/a.png', '/external/b.png']))
    await probe.setDisabled(true)
    await act(async () => authorization.resolve())
    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(mocks.authorizeExternalPath).toHaveBeenCalledTimes(1)
  })

  it('does not attach local paths when the owner changes during authorization', async () => {
    const authorization = deferred<void>()
    let owner: { kind: 'local' } | { kind: 'runtime' } = { kind: 'local' }
    mocks.resolveNativeChatAttachmentOwner.mockImplementation(() => owner)
    mocks.authorizeExternalPath.mockReturnValueOnce(authorization.promise)
    const attachResolvedPaths = vi.fn()
    const notices: (string | null)[] = []
    const probe = await renderProbe({
      attachResolvedPaths,
      setNotice: (notice) => notices.push(notice)
    })

    act(() => probe.latest().attachExternalPaths(['/external/a.png', '/external/b.png']))
    owner = { kind: 'runtime' }
    await act(async () => authorization.resolve())

    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(mocks.authorizeExternalPath).toHaveBeenCalledTimes(1)
    expect(notices.at(-1)).toBe(
      'This workspace changed hosts while attaching — drop the files again.'
    )
  })

  // The owner flipping during the LAST path has no next iteration to catch it,
  // so the post-loop check is the only thing standing between a one-file drop
  // and a path attached to a host that no longer owns it.
  it('reports a one-file drop whose owner changes during its authorization', async () => {
    const authorization = deferred<void>()
    let owner: { kind: 'local' } | { kind: 'runtime' } = { kind: 'local' }
    mocks.resolveNativeChatAttachmentOwner.mockImplementation(() => owner)
    mocks.authorizeExternalPath.mockReturnValueOnce(authorization.promise)
    const attachResolvedPaths = vi.fn()
    const notices: (string | null)[] = []
    const probe = await renderProbe({
      attachResolvedPaths,
      setNotice: (notice) => notices.push(notice)
    })

    act(() => probe.latest().attachExternalPaths(['/external/only.pdf']))
    owner = { kind: 'runtime' }
    await act(async () => authorization.resolve())

    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(notices.at(-1)).toBe(
      'This workspace changed hosts while attaching — drop the files again.'
    )
  })

  // Both workspaces answer `local`, so the owner alone cannot tell them apart:
  // only asking which workspace this composer serves now catches a tab that
  // moved while the authorization was still in flight.
  it('does not attach when the pane changes workspace during authorization', async () => {
    const authorization = deferred<void>()
    mocks.authorizeExternalPath.mockReturnValueOnce(authorization.promise)
    const attachResolvedPaths = vi.fn()
    const notices: (string | null)[] = []
    const probe = await renderProbe({
      structuredWorktreeId: 'worktree-1',
      attachResolvedPaths,
      setNotice: (notice) => notices.push(notice)
    })

    act(() => probe.latest().attachExternalPaths(['/external/only.pdf']))
    await probe.setStructuredWorktreeId('worktree-2')
    await act(async () => authorization.resolve())

    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(notices.at(-1)).toBe(
      'This workspace changed hosts while attaching — drop the files again.'
    )
  })

  // The upload window is the long one: the paths go to the remote worktree the
  // attach captured, so a pane that moved workspaces meanwhile must not receive
  // remote paths that live under the workspace it left.
  it('does not attach uploaded paths when the pane changes workspace during upload', async () => {
    const sshOwner = {
      kind: 'ssh',
      connectionId: 'conn-1',
      worktreePath: '/remote/wt',
      expectedExecutionHostId: 'ssh:conn-1',
      expectedSshTargetId: 'conn-1',
      expectedSshConnectionGeneration: 4
    } as const
    mocks.resolveNativeChatAttachmentOwnerForWorktree.mockReturnValue(sshOwner)
    const upload = deferred<string[]>()
    mocks.uploadNativeChatAttachmentPaths.mockReturnValueOnce(upload.promise)
    const attachResolvedPaths = vi.fn()
    const notices: (string | null)[] = []
    const probe = await renderProbe({
      structuredWorktreeId: 'worktree-1',
      attachResolvedPaths,
      setNotice: (notice) => notices.push(notice)
    })

    act(() => probe.latest().attachExternalPaths(['/local/a.txt']))
    await probe.setStructuredWorktreeId('worktree-2')
    await act(async () => upload.resolve(['/remote/wt/.orca/drops/a.txt']))

    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(notices.at(-1)).toBe(
      'This workspace changed hosts while attaching — drop the files again.'
    )
  })

  it('uploads SSH worktree paths and attaches the remote results', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({
      kind: 'ssh',
      connectionId: 'conn-1',
      worktreePath: '/remote/wt',
      expectedExecutionHostId: 'ssh:conn-1',
      expectedSshTargetId: 'conn-1',
      expectedSshConnectionGeneration: 4
    })
    mocks.uploadNativeChatAttachmentPaths.mockResolvedValue(['/remote/wt/.orca/drops/a.txt'])
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })
    await act(async () => {
      probe.latest().attachExternalPaths(['/local/a.txt'])
    })
    expect(mocks.uploadNativeChatAttachmentPaths).toHaveBeenCalledWith(['/local/a.txt'], {
      kind: 'ssh',
      connectionId: 'conn-1',
      worktreePath: '/remote/wt',
      expectedExecutionHostId: 'ssh:conn-1',
      expectedSshTargetId: 'conn-1',
      expectedSshConnectionGeneration: 4
    })
    expect(attachResolvedPaths).toHaveBeenCalledWith(['/remote/wt/.orca/drops/a.txt'], 'conn-1')
    expect(mocks.authorizeExternalPath).not.toHaveBeenCalled()
  })

  it('delivers concurrent SSH resolutions in order without deduplicating paths', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({
      kind: 'ssh',
      connectionId: 'conn-1',
      worktreePath: '/remote/wt',
      expectedExecutionHostId: 'ssh:conn-1',
      expectedSshTargetId: 'conn-1',
      expectedSshConnectionGeneration: 4
    })
    const firstUpload = deferred<string[]>()
    const secondUpload = deferred<string[]>()
    mocks.uploadNativeChatAttachmentPaths
      .mockReturnValueOnce(firstUpload.promise)
      .mockReturnValueOnce(secondUpload.promise)
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })

    act(() => {
      probe.latest().attachExternalPaths(['/local/a.txt'])
      probe.latest().attachExternalPaths(['/local/b.txt'])
    })
    await act(async () => {
      secondUpload.resolve(['/remote/wt/.orca/drops/b.txt', '/remote/wt/.orca/drops/b.txt'])
    })
    await act(async () => {
      firstUpload.resolve(['/remote/wt/.orca/drops/a.txt'])
    })

    expect(attachResolvedPaths.mock.calls).toEqual([
      [['/remote/wt/.orca/drops/b.txt', '/remote/wt/.orca/drops/b.txt'], 'conn-1'],
      [['/remote/wt/.orca/drops/a.txt'], 'conn-1']
    ])
  })

  it('shows the not-ready notice instead of attaching unresolved paths', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'not-ready' })
    const attachResolvedPaths = vi.fn()
    const setNotice = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths, setNotice })
    await act(async () => {
      probe.latest().attachExternalPaths(['/local/a.txt'])
    })
    expect(setNotice).toHaveBeenCalledWith('Worktree not ready — try again in a moment.')
    expect(attachResolvedPaths).not.toHaveBeenCalled()
  })

  it('does not attach client-local paths to a remote runtime', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'runtime' })
    const attachResolvedPaths = vi.fn()
    const setNotice = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths, setNotice })
    await act(async () => {
      probe.latest().attachExternalPaths(['/local/a.txt'])
    })
    expect(setNotice).toHaveBeenCalledWith(
      'Local attachments are not available for remote sessions.'
    )
    expect(attachResolvedPaths).not.toHaveBeenCalled()
  })

  it('ignores local attachment insertion while already disabled', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'local' })
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ disabled: true, attachResolvedPaths })

    act(() => probe.latest().attachExternalPaths(['/local/a.txt']))

    expect(mocks.resolveNativeChatAttachmentOwner).not.toHaveBeenCalled()
    expect(attachResolvedPaths).not.toHaveBeenCalled()
  })

  it('drops an upload that resolves after the composer became disabled', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({
      kind: 'ssh',
      connectionId: 'conn-1',
      worktreePath: '/remote/wt',
      expectedExecutionHostId: 'ssh:conn-1',
      expectedSshTargetId: 'conn-1',
      expectedSshConnectionGeneration: 4
    })
    let resolveUpload: (paths: string[]) => void = () => {}
    mocks.uploadNativeChatAttachmentPaths.mockReturnValue(
      new Promise<string[]>((resolve) => {
        resolveUpload = resolve
      })
    )
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })
    await act(async () => {
      probe.latest().attachExternalPaths(['/local/a.txt'])
    })
    await probe.setDisabled(true)
    await act(async () => {
      resolveUpload(['/remote/wt/.orca/drops/a.txt'])
    })
    expect(attachResolvedPaths).not.toHaveBeenCalled()
  })

  it('drops an upload that resolves after the SSH owner generation changes', async () => {
    const initialOwner = {
      kind: 'ssh' as const,
      connectionId: 'conn-1',
      worktreePath: '/remote/wt',
      expectedExecutionHostId: 'ssh:conn-1' as const,
      expectedSshTargetId: 'conn-1',
      expectedSshConnectionGeneration: 4
    }
    mocks.resolveNativeChatAttachmentOwner
      .mockReturnValueOnce(initialOwner)
      .mockReturnValue({ ...initialOwner, expectedSshConnectionGeneration: 5 })
    const upload = deferred<string[]>()
    mocks.uploadNativeChatAttachmentPaths.mockReturnValue(upload.promise)
    const attachResolvedPaths = vi.fn()
    const notices: (string | null)[] = []
    const probe = await renderProbe({
      attachResolvedPaths,
      setNotice: (notice) => notices.push(notice)
    })

    act(() => probe.latest().attachExternalPaths(['/local/a.txt']))
    await act(async () => upload.resolve(['/remote/wt/.orca/drops/a.txt']))

    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(notices.at(-1)).toBe(
      'This workspace changed hosts while attaching — drop the files again.'
    )
  })

  describe('a structured chat on a paired server', () => {
    const session = { sessionId: 'session-1', runtimeEnvironmentId: 'env-1' }
    const target = {
      environmentId: 'env-1',
      sessionId: 'session-1',
      expectedEnvironmentPairingRevision: 7,
      expectedEnvironmentRuntimeId: 'runtime-a'
    }

    /** `removed`: chips the user clicked away, which the composer no longer holds. */
    function trackingChips(): NativeChatPendingAttachmentChips & {
      begun: string[]
      removed: Set<string>
    } {
      const begun: string[] = []
      const removed = new Set<string>()
      return {
        begun,
        removed,
        begin: vi.fn((_preview?: string, name?: string) => {
          begun.push(name ?? '')
          return `chip-${begun.length}`
        }),
        resolve: vi.fn(),
        drop: vi.fn((id: string) => !removed.has(id))
      }
    }

    function uploaded(
      pairs: [sourcePath: string, path: string][],
      failed: string[] = []
    ): AgentSessionAttachmentPathUploadResult {
      return {
        uploaded: pairs.map(([sourcePath, path]) => ({ sourcePath, path })),
        skipped: [],
        failed: failed.map((sourcePath) => ({ sourcePath, reason: 'upload failed' }))
      }
    }

    beforeEach(() => {
      replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 7 }])
      mocks.prepareNativeChatSessionAttachmentUpload.mockReset().mockResolvedValue({
        ok: true,
        target
      })
      mocks.uploadNativeChatSessionAttachmentPaths.mockReset()
    })

    it('uploads into the chat store and attaches only server paths', async () => {
      const upload = deferred<AgentSessionAttachmentPathUploadResult>()
      mocks.uploadNativeChatSessionAttachmentPaths.mockReturnValueOnce(upload.promise)
      const chips = trackingChips()
      const attachResolvedPaths = vi.fn()
      const probe = await renderProbe({
        structuredWorktreeId: 'worktree-1',
        structuredSession: session,
        attachResolvedPaths,
        pendingChips: chips
      })

      act(() => probe.latest().attachExternalPaths(['/Users/me/shot.png', '/Users/me/notes.md']))
      // Pending chips appear before the upload settles, so Send waits for both files.
      expect(chips.begun).toEqual(['shot.png', 'notes.md'])
      await act(async () =>
        upload.resolve(
          uploaded([
            ['/Users/me/shot.png', '/srv/agent-session-attachments/u1/shot.png'],
            ['/Users/me/notes.md', '/srv/agent-session-attachments/u2/notes.md']
          ])
        )
      )

      expect(mocks.uploadNativeChatSessionAttachmentPaths).toHaveBeenCalledWith(
        ['/Users/me/shot.png', '/Users/me/notes.md'],
        target
      )
      expect(chips.resolve).toHaveBeenCalledExactlyOnceWith(
        'chip-1',
        '/srv/agent-session-attachments/u1/shot.png',
        null
      )
      expect(chips.drop).toHaveBeenCalledExactlyOnceWith('chip-2')
      expect(attachResolvedPaths).toHaveBeenCalledExactlyOnceWith(
        ['/srv/agent-session-attachments/u2/notes.md'],
        null
      )
      expect(mocks.authorizeExternalPath).not.toHaveBeenCalled()
    })

    it('does not insert a file whose chip the user removed while it uploaded', async () => {
      const upload = deferred<AgentSessionAttachmentPathUploadResult>()
      mocks.uploadNativeChatSessionAttachmentPaths.mockReturnValueOnce(upload.promise)
      const chips = trackingChips()
      const attachResolvedPaths = vi.fn()
      const probe = await renderProbe({
        structuredWorktreeId: 'worktree-1',
        structuredSession: session,
        attachResolvedPaths,
        pendingChips: chips
      })

      act(() => probe.latest().attachExternalPaths(['/Users/me/report.pdf', '/Users/me/notes.md']))
      chips.removed.add('chip-1')
      await act(async () =>
        upload.resolve(
          uploaded([
            ['/Users/me/report.pdf', '/srv/agent-session-attachments/u1/report.pdf'],
            ['/Users/me/notes.md', '/srv/agent-session-attachments/u2/notes.md']
          ])
        )
      )

      expect(attachResolvedPaths).toHaveBeenCalledExactlyOnceWith(
        ['/srv/agent-session-attachments/u2/notes.md'],
        null
      )
    })

    it('names, in one notice, each file that did not attach', async () => {
      mocks.uploadNativeChatSessionAttachmentPaths.mockResolvedValueOnce(
        uploaded(
          [['/Users/me/notes.md', '/srv/agent-session-attachments/u2/notes.md']],
          ['/Users/me/huge.mov']
        )
      )
      const chips = trackingChips()
      const attachResolvedPaths = vi.fn()
      const notices: (string | null)[] = []
      const probe = await renderProbe({
        structuredWorktreeId: 'worktree-1',
        structuredSession: session,
        attachResolvedPaths,
        pendingChips: chips,
        setNotice: (notice) => notices.push(notice)
      })

      await act(async () =>
        probe.latest().attachExternalPaths(['/Users/me/huge.mov', '/Users/me/notes.md'])
      )

      expect(chips.drop).toHaveBeenCalledWith('chip-1')
      expect(attachResolvedPaths).toHaveBeenCalledExactlyOnceWith(
        ['/srv/agent-session-attachments/u2/notes.md'],
        null
      )
      expect(notices).toEqual(["Couldn't attach huge.mov."])
      expect(mocks.toastLoading).not.toHaveBeenCalled()
    })

    it('refuses on a server without the attachment store, uploading nothing', async () => {
      mocks.prepareNativeChatSessionAttachmentUpload.mockResolvedValueOnce({
        ok: false,
        notice: 'needs newer server'
      })
      const chips = trackingChips()
      const attachResolvedPaths = vi.fn()
      const notices: (string | null)[] = []
      const probe = await renderProbe({
        structuredWorktreeId: 'worktree-1',
        structuredSession: session,
        attachResolvedPaths,
        pendingChips: chips,
        setNotice: (notice) => notices.push(notice)
      })

      await act(async () => probe.latest().attachExternalPaths(['/Users/me/shot.png']))

      expect(mocks.uploadNativeChatSessionAttachmentPaths).not.toHaveBeenCalled()
      expect(chips.drop).toHaveBeenCalledExactlyOnceWith('chip-1')
      expect(attachResolvedPaths).not.toHaveBeenCalled()
      expect(notices.at(-1)).toBe('needs newer server')
    })

    it('says which file did not attach when the upload itself fails, such as on a re-pair', async () => {
      // Main refuses every chunk once the pairing changes, so the whole upload call fails.
      mocks.uploadNativeChatSessionAttachmentPaths.mockRejectedValueOnce(
        new Error('Runtime environment changed')
      )
      const chips = trackingChips()
      const attachResolvedPaths = vi.fn()
      const notices: (string | null)[] = []
      const probe = await renderProbe({
        structuredWorktreeId: 'worktree-1',
        structuredSession: session,
        attachResolvedPaths,
        pendingChips: chips,
        setNotice: (notice) => notices.push(notice)
      })

      await act(async () => probe.latest().attachExternalPaths(['/Users/me/shot.png']))

      expect(chips.resolve).not.toHaveBeenCalled()
      expect(chips.drop).toHaveBeenCalledExactlyOnceWith('chip-1')
      expect(attachResolvedPaths).not.toHaveBeenCalled()
      expect(notices).toEqual(["Couldn't attach shot.png."])
    })

    it('keeps a local structured chat on the worktree owner', async () => {
      const attachResolvedPaths = vi.fn()
      const probe = await renderProbe({
        structuredWorktreeId: 'worktree-1',
        structuredSession: { sessionId: 'session-1', runtimeEnvironmentId: null },
        attachResolvedPaths
      })
      await act(async () => probe.latest().attachExternalPaths(['/local/a.txt']))
      expect(mocks.resolveNativeChatAttachmentOwnerForWorktree).toHaveBeenCalled()
      expect(mocks.prepareNativeChatSessionAttachmentUpload).not.toHaveBeenCalled()
      expect(attachResolvedPaths).toHaveBeenCalledWith(['/local/a.txt'])
    })
  })
})
