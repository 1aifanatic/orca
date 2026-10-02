import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromises from 'node:fs/promises'
import type { KernelFrame } from '../../shared/notebook-kernel-types'

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
const { startNotebookKernelMock, resolveAuthorizedPathMock } = vi.hoisted(() => ({
  startNotebookKernelMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('./local-file-access-resolution', () => ({
  resolveUserNamedRegularFile: resolveAuthorizedPathMock,
  resolveDesktopAuthorizedPath: resolveAuthorizedPathMock
}))
vi.mock('../notebook/notebook-kernel', () => ({ startNotebookKernel: startNotebookKernelMock }))
// Why: the mocked resolver returns made-up `/real/...` paths, which stand for real files already.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    realpath: async (path: string) => (path.startsWith('/real/') ? path : actual.realpath(path))
  }
})

import { registerNotebookHandlers } from './notebook'
import type { Store } from '../persistence'
import type * as FileAccessResolution from './local-file-access-resolution'

function fakeKernel() {
  let onFrame: (frame: KernelFrame) => void = () => {}
  const kernel = { execute: vi.fn(), interrupt: vi.fn(), shutdown: vi.fn() }
  startNotebookKernelMock.mockImplementationOnce((options) => {
    onFrame = options.onFrame
    return { kernel, ready: Promise.resolve({ status: 'ready' }), exited: new Promise(() => {}) }
  })
  return { kernel, emit: (frame: KernelFrame) => onFrame(frame) }
}

function fakeOwner() {
  return Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false })
}

describe('notebook IPC', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    resolveAuthorizedPathMock.mockImplementation(async (path: string) => `/real${path}`)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test only pass the store to the mocked authorizer.
    registerNotebookHandlers({} as Store)
  })

  it('starts one kernel per notebook in its folder and routes its frames to the owning window', async () => {
    const first = fakeKernel()
    const owner = fakeOwner()
    const start = handlers.get('notebook:startKernel')!
    await expect(
      start({ sender: owner }, { filePath: '/repo/nb.ipynb', python: '/py' })
    ).resolves.toEqual({ status: 'ready' })
    expect(startNotebookKernelMock).toHaveBeenCalledWith(
      expect.objectContaining({ python: '/py', cwd: '/real/repo' })
    )

    await handlers.get('notebook:execute')!(
      { sender: owner },
      { filePath: '/repo/nb.ipynb', code: 'x' }
    )
    expect(first.kernel.execute).toHaveBeenCalledWith('x')
    first.emit({ type: 'done', status: 'ok', execution_count: 1 })
    expect(owner.send).toHaveBeenCalledWith('notebook:kernelFrame', {
      filePath: '/repo/nb.ipynb',
      frame: { type: 'done', status: 'ok', execution_count: 1 }
    })

    fakeKernel()
    await start({ sender: owner }, { filePath: '/repo/nb.ipynb', python: '/py' })
    expect(first.kernel.shutdown).toHaveBeenCalledOnce()
  })

  it.each(['destroyed', 'render-process-gone', 'did-navigate'])(
    'shuts down a renderer’s kernels on %s',
    async (lifecycleEvent) => {
      const { kernel } = fakeKernel()
      const owner = fakeOwner()
      await handlers.get('notebook:startKernel')!(
        { sender: owner },
        { filePath: '/repo/nb.ipynb', python: '/py' }
      )
      owner.emit(lifecycleEvent)
      expect(kernel.shutdown).toHaveBeenCalledOnce()
      await handlers.get('notebook:execute')!(
        { sender: owner },
        { filePath: '/repo/nb.ipynb', code: 'x' }
      )
      expect(kernel.execute).not.toHaveBeenCalled()
    }
  )

  it('keeps each window’s kernel for the same notebook separate', async () => {
    const first = fakeKernel()
    const second = fakeKernel()
    const [a, b] = [fakeOwner(), fakeOwner()]
    const start = handlers.get('notebook:startKernel')!
    await start({ sender: a }, { filePath: '/repo/nb.ipynb', python: '/py' })
    await start({ sender: b }, { filePath: '/repo/nb.ipynb', python: '/py' })
    expect(first.kernel.shutdown).not.toHaveBeenCalled()
    await handlers.get('notebook:execute')!(
      { sender: b },
      { filePath: '/repo/nb.ipynb', code: 'x' }
    )
    expect(second.kernel.execute).toHaveBeenCalledWith('x')
    expect(first.kernel.execute).not.toHaveBeenCalled()
  })

  it('starts a kernel for a notebook outside every project, and refuses a relative path', async () => {
    const actual = await vi.importActual<typeof FileAccessResolution>(
      './local-file-access-resolution'
    )
    resolveAuthorizedPathMock.mockImplementation(actual.resolveUserNamedRegularFile)
    const folder = await mkdtemp(join(await realpath(tmpdir()), 'orca-notebook-'))
    try {
      const notebook = join(folder, 'analysis.ipynb')
      await writeFile(notebook, '{}')
      fakeKernel()
      const start = handlers.get('notebook:startKernel')!

      await expect(
        start({ sender: fakeOwner() }, { filePath: notebook, python: '/py' })
      ).resolves.toEqual({ status: 'ready' })
      expect(startNotebookKernelMock).toHaveBeenCalledWith(expect.objectContaining({ cwd: folder }))
      await expect(
        start({ sender: fakeOwner() }, { filePath: 'analysis.ipynb', python: '/py' })
      ).rejects.toThrow('absolute path')
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
