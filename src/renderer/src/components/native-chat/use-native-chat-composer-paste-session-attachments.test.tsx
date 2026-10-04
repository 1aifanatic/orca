// @vitest-environment happy-dom
// Pastes into a structured chat on a paired server land in that server's attachment store, on
// every paste path, and the chip keeps the store's owner.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  NativeChatAttachmentHostOwner,
  NativeChatAttachmentOwner
} from './native-chat-attachment-upload'

const mocks = vi.hoisted(() => ({
  saveClipboardImageAsTempFile: vi.fn(),
  readClipboardText: vi.fn(),
  readClipboardImageThumbnail: vi.fn(),
  clipboardHasImage: vi.fn(),
  readClipboardFilePaths: vi.fn(),
  prepareNativeChatSessionAttachmentUpload: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./native-chat-composer-target', () => ({
  NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES: 1024
}))

vi.mock('./native-chat-attachment-upload', () => ({
  nativeChatLocalAttachmentUnsupportedNotice: () =>
    'Local attachments are not available for remote sessions.',
  nativeChatWorktreeNotReadyNotice: () => 'Worktree not ready — try again in a moment.',
  nativeChatAttachmentHostOwner: (owner: NativeChatAttachmentHostOwner) => ({
    environmentId: owner.environmentId,
    pairingRevision: owner.pairingRevision,
    sessionId: owner.sessionId
  }),
  prepareNativeChatSessionAttachmentUpload: mocks.prepareNativeChatSessionAttachmentUpload
}))

vi.stubGlobal('window', {
  api: {
    ui: {
      saveClipboardImageAsTempFile: mocks.saveClipboardImageAsTempFile,
      readClipboardText: mocks.readClipboardText,
      readClipboardImageThumbnail: mocks.readClipboardImageThumbnail,
      clipboardHasImage: mocks.clipboardHasImage,
      readClipboardFilePaths: mocks.readClipboardFilePaths
    }
  }
})
vi.stubGlobal('URL', {
  createObjectURL: () => 'blob:clipboard-image',
  revokeObjectURL: () => {}
})

import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'

type HookApi = ReturnType<typeof useNativeChatComposerPaste>
type Chip = {
  id: string
  path: string
  pending: boolean
  hostOwner?: NativeChatAttachmentHostOwner
}

const sessionOwner: NativeChatAttachmentOwner = {
  kind: 'runtime-session',
  environmentId: 'env-1',
  pairingRevision: 7,
  sessionId: 'session-1'
}
const hostOwner = { environmentId: 'env-1', pairingRevision: 7, sessionId: 'session-1' }
const storeArgs = {
  runtimeEnvironmentId: 'env-1',
  agentSessionAttachment: {
    sessionId: 'session-1',
    expectedEnvironmentPairingRevision: 7,
    expectedEnvironmentRuntimeId: 'runtime-a'
  }
}
const storedPath = '/srv/agent-session-attachments/s/u1/orca-paste-1.png'

let root: Root | null = null

async function renderPaste(args: {
  attachResolvedPaths?: (...args: unknown[]) => void
  insertTypedText?: (text: string) => boolean
  setNotice?: (notice: string | null) => void
}): Promise<{ api: () => HookApi; chips: Chip[] }> {
  const chips: Chip[] = []
  let counter = 0
  let api: HookApi | null = null
  function Probe(): null {
    api = useNativeChatComposerPaste({
      targetKey: 'session-1',
      agent: 'claude',
      disabled: false,
      caret: 0,
      setCaret: () => {},
      resolveAttachmentOwner: () => sessionOwner,
      attachResolvedPaths: args.attachResolvedPaths ?? (() => {}),
      beginPendingImageAttachment: () => {
        counter += 1
        chips.push({ id: `chip-${counter}`, path: '', pending: true })
        return `chip-${counter}`
      },
      resolvePendingImageAttachment: (id, path, _connectionId, owner) => {
        const chip = chips.find((candidate) => candidate.id === id)
        if (chip) {
          Object.assign(chip, { path, pending: false, hostOwner: owner })
        }
      },
      dropPendingImageAttachment: (id) => {
        chips.splice(
          chips.findIndex((candidate) => candidate.id === id),
          1
        )
      },
      insertTypedText: args.insertTypedText ?? (() => true),
      setNotice: args.setNotice ?? (() => {})
    })
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(createElement(Probe)))
  return {
    api: () => {
      if (!api) {
        throw new Error('Probe did not render')
      }
      return api
    },
    chips
  }
}

function imagePasteEvent(text = ''): ClipboardEvent {
  const data = new DataTransfer()
  data.items.add(new File(['image'], 'image.png', { type: 'image/png' }))
  if (text) {
    data.setData('text/plain', text)
  }
  return new ClipboardEvent('paste', { clipboardData: data, cancelable: true })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.readClipboardText.mockResolvedValue('')
  mocks.readClipboardImageThumbnail.mockResolvedValue(null)
  mocks.clipboardHasImage.mockResolvedValue(false)
  mocks.readClipboardFilePaths.mockResolvedValue([])
  mocks.prepareNativeChatSessionAttachmentUpload.mockResolvedValue({
    ok: true,
    target: {
      environmentId: 'env-1',
      sessionId: 'session-1',
      expectedEnvironmentPairingRevision: 7,
      expectedEnvironmentRuntimeId: 'runtime-a'
    }
  })
  mocks.saveClipboardImageAsTempFile.mockResolvedValue(storedPath)
})

afterEach(() => {
  root?.unmount()
  root = null
})

describe('pasting into a structured chat on a paired server', () => {
  it('saves a pasted image into the chat store and settles the chip with its owner', async () => {
    const probe = await renderPaste({})
    await act(async () => probe.api().handlePaste(imagePasteEvent()))
    expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledExactlyOnceWith(storeArgs)
    expect(probe.chips).toEqual([{ id: 'chip-1', path: storedPath, pending: false, hostOwner }])
  })

  it('keeps the image of a paste that also carries text', async () => {
    const insertTypedText = vi.fn(() => true)
    const probe = await renderPaste({ insertTypedText })
    await act(async () => probe.api().handlePaste(imagePasteEvent('caption')))
    expect(insertTypedText).toHaveBeenCalledWith('caption')
    expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledExactlyOnceWith(storeArgs)
    expect(probe.chips).toMatchObject([{ path: storedPath, pending: false }])
  })

  it('pastes from the button into the chat store', async () => {
    mocks.readClipboardImageThumbnail.mockResolvedValue({ dataUrl: 'data:image/png;base64,AA' })
    const probe = await renderPaste({})
    await act(async () => probe.api().pasteFromClipboard())
    expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledExactlyOnceWith(storeArgs)
    expect(probe.chips).toEqual([{ id: 'chip-1', path: storedPath, pending: false, hostOwner }])
  })

  it('attaches with its owner when no placeholder chip was shown', async () => {
    const attachResolvedPaths = vi.fn()
    const probe = await renderPaste({ attachResolvedPaths })
    await act(async () => probe.api().pasteFromClipboard())
    expect(attachResolvedPaths).toHaveBeenCalledExactlyOnceWith([storedPath], null, { hostOwner })
  })

  it('refuses on a server without the attachment store and saves nothing', async () => {
    mocks.prepareNativeChatSessionAttachmentUpload.mockResolvedValue({
      ok: false,
      notice: 'needs newer server'
    })
    const setNotice = vi.fn()
    const probe = await renderPaste({ setNotice })
    await act(async () => probe.api().handlePaste(imagePasteEvent()))
    expect(mocks.saveClipboardImageAsTempFile).not.toHaveBeenCalled()
    expect(setNotice).toHaveBeenLastCalledWith('needs newer server')
    expect(probe.chips).toHaveLength(0)
  })
})
