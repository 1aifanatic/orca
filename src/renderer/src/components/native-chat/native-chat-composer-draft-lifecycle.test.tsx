// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type * as DraftHook from './use-native-chat-draft'
import type * as AttachmentsHook from './use-native-chat-composer-attachments'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({ isRemoteRuntimePtyId: () => false }))
const mocks = vi.hoisted(() => {
  const launchDrafts: Record<string, NativeChatLaunchDraft> = {}
  return { launchDrafts }
})
vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ nativeChatLaunchDraftByTabId: mocks.launchDrafts }),
    {
      getState: () => ({
        nativeChatLaunchDraftByTabId: mocks.launchDrafts,
        markNativeChatLaunchDraftAdopted: (tabId: string) => {
          const current = mocks.launchDrafts[tabId]
          if (current) {
            mocks.launchDrafts[tabId] = { ...current, adopted: true }
          }
        },
        clearNativeChatLaunchDraft: (tabId: string) => {
          delete mocks.launchDrafts[tabId]
        }
      })
    }
  )
}))

const DRAFT_KEY_PREFIX = 'orca:nativeChatComposerDraft:v1:'

type ComposerApi = {
  draft: string
  setDraft: ReturnType<typeof DraftHook.useNativeChatDraft>['setDraft']
  attachments: ReturnType<typeof AttachmentsHook.useNativeChatComposerAttachments>
}

let root: Root | null = null
let host: HTMLElement | null = null

async function mount(element: React.ReactElement): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root?.render(element))
}

async function unmount(): Promise<void> {
  await act(async () => root?.unmount())
  root = null
  host?.remove()
  host = null
}

function storedDraft(scopeKey: string): unknown {
  const raw = localStorage.getItem(`${DRAFT_KEY_PREFIX}${encodeURIComponent(scopeKey)}`)
  return raw === null ? null : JSON.parse(raw)
}

/** A fresh renderer: module memory is gone, localStorage is not. */
async function loadHooks(): Promise<{
  draftHook: typeof DraftHook
  attachmentsHook: typeof AttachmentsHook
}> {
  vi.resetModules()
  return {
    draftHook: await import('./use-native-chat-draft'),
    attachmentsHook: await import('./use-native-chat-composer-attachments')
  }
}

function composer(
  hooks: Awaited<ReturnType<typeof loadHooks>>,
  onRender: (api: ComposerApi) => void
): (props: { scopeKey: string }) => null {
  return function Composer({ scopeKey }) {
    const { draft, setDraft } = hooks.draftHook.useNativeChatDraft(scopeKey, () => false)
    const [, setCaret] = useState(0)
    const attachments = hooks.attachmentsHook.useNativeChatComposerAttachments({
      attachmentScopeKey: scopeKey,
      allowWithoutTarget: true,
      caret: 0,
      disabled: false,
      isComposing: () => false,
      resolveTarget: () => null,
      textareaRef: { current: null },
      setCaret,
      setDraft: () => {},
      setNotice: () => {}
    })
    onRender({ draft, setDraft, attachments })
    return null
  }
}

beforeEach(() => {
  localStorage.clear()
  mocks.launchDrafts = {}
})

afterEach(async () => {
  await unmount()
  vi.useRealTimers()
  localStorage.clear()
})

describe('native-chat composer draft lifecycle', () => {
  it('clears the saved draft when a send settles after the composer unmounted', async () => {
    const hooks = await loadHooks()
    const seen: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => {
          seen.api = next
        }),
        { scopeKey: 'tab-1:pane' }
      )
    )
    await act(async () => {
      seen.api?.setDraft('/goal ship it')
      hooks.attachmentsHook.appendNativeChatAttachmentCache('tab-1:pane', [
        { id: 'i1', path: '/tmp/orca-paste-1.png' }
      ])
    })
    window.dispatchEvent(new Event('pagehide'))
    expect(storedDraft('tab-1:pane')).toMatchObject({ text: '/goal ship it' })
    const held = seen.api

    // A question prompt replaces the composer while the host accepts the command.
    await unmount()
    held?.setDraft('')
    held?.attachments.clearImageAttachments()

    expect(storedDraft('tab-1:pane')).toBeNull()
    const reloaded = await loadHooks()
    const restored: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(reloaded, (next) => {
          restored.api = next
        }),
        { scopeKey: 'tab-1:pane' }
      )
    )
    expect(restored.api).toMatchObject({ draft: '', attachments: { imageAttachments: [] } })
  })

  it('leaves nothing saved when a send clears a draft whose typing was still deferred', async () => {
    vi.useFakeTimers()
    const hooks = await loadHooks()
    const seen: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => {
          seen.api = next
        }),
        { scopeKey: 'tab-1:pane' }
      )
    )
    await act(async () => {
      seen.api?.attachments.attachResolvedPaths(['/repo/a.png'])
    })
    await act(async () => {
      seen.api?.setDraft('hello')
    })
    await act(async () => {
      seen.api?.setDraft('')
      seen.api?.attachments.clearImageAttachments()
    })
    expect(storedDraft('tab-1:pane')).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    window.dispatchEvent(new Event('pagehide'))
    expect(storedDraft('tab-1:pane')).toBeNull()
  })

  it('does not bring back a sent image when a paste from a replaced composer is dropped late', async () => {
    const hooks = await loadHooks()
    const first: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => {
          first.api = next
        }),
        { scopeKey: 'tab-1:pane' }
      )
    )
    await act(async () => first.api?.attachments.attachResolvedPaths(['/repo/x.png']))
    const pending: { id?: string | null } = {}
    await act(async () => {
      pending.id = first.api?.attachments.beginPendingImageAttachment('data:image/png;base64,AA')
    })
    expect(pending.id).toBeTruthy()
    const stale = first.api
    // The composer is replaced while the paste is still being saved.
    await unmount()
    const second: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => {
          second.api = next
        }),
        { scopeKey: 'tab-1:pane' }
      )
    )
    expect(second.api?.attachments.imageAttachments.map(({ path }) => path)).toEqual([
      '/repo/x.png'
    ])
    await act(async () => second.api?.attachments.clearImageAttachments())
    await unmount()

    // The paste's save fails late in the replaced composer, which drops its placeholder.
    stale?.attachments.dropPendingImageAttachment(pending.id ?? '')

    expect(storedDraft('tab-1:pane')).toBeNull()
    const third: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => {
          third.api = next
        }),
        { scopeKey: 'tab-1:pane' }
      )
    )
    expect(third.api?.attachments.imageAttachments).toEqual([])
  })

  it('does not bring back an untouched launch link after a reload, when no seed is left to replace it', async () => {
    const link = 'https://github.com/o/r/issues/12'
    const seed: NativeChatLaunchDraft = {
      tabId: 'tab-1',
      agent: 'claude',
      text: link,
      createdAt: 1
    }
    mocks.launchDrafts['tab-1'] = seed
    const hooks = await loadHooks()
    const { useNativeChatLaunchDraftAdoption } =
      await import('./use-native-chat-launch-draft-adoption')
    let shown = ''
    function Composer({ launchDraft }: { launchDraft: NativeChatLaunchDraft }): null {
      const { draft, setDraft } = hooks.draftHook.useNativeChatDraft('tab-1:leaf', () => false)
      useNativeChatLaunchDraftAdoption({
        terminalTabId: 'tab-1',
        agent: 'claude',
        launchDraft,
        launchDraftResolved: false,
        draft,
        setDraft,
        setCaret: () => {},
        ownsTabWideLaunchDraft: true
      })
      shown = draft
      return null
    }
    await mount(createElement(Composer, { launchDraft: seed }))
    expect(shown).toBe(link)
    window.dispatchEvent(new Event('pagehide'))
    await unmount()

    mocks.launchDrafts = {}
    const reloaded = await loadHooks()
    const restored: { draft?: string } = {}
    function Reloaded(): null {
      restored.draft = reloaded.draftHook.useNativeChatDraft('tab-1:leaf', () => false).draft
      return null
    }
    await mount(createElement(Reloaded))
    expect(restored.draft).toBe('')
  })
})
