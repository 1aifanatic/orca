// The phone's own hooks: a phone that sent the never-opened send itself, holding its echo, and
// reading the host's Stopping from the status feed, must show the same list after every frame as a
// phone that opened the chat fresh at that frame; and the real overlay and chat view must hand the
// FlatList the stop row from the frame that took the send back. Not covered: the row components and
// native rendering, the controller and lane that build the overlay's inputs, and a transport that
// reconnects and resubscribes.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { MobileNativeChatOverlay } from './MobileNativeChatOverlay'
import {
  buildMobileNativeChatTransientData,
  foldMobileNativeChatMessages
} from './mobile-native-chat-render-data'
import {
  NEVER_OPENED,
  STOP_JOURNAL_SESSION,
  stopJournal
} from './mobile-native-chat-stop-journal.test-fixture'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'
import type { MobileNativeChatController } from './use-mobile-native-chat-controller'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))
// The chat view's own test mocks: the FlatList is a host element whose `data` the test reads.
vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    FlatList: React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd: vi.fn(), scrollToOffset: vi.fn() }), [])
      return React.createElement('FlatList', props)
    }),
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFillObject: {} },
    Text: 'Text',
    View: 'View'
  }
})
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', () => {
  const chain = { runOnJS: () => chain, onStart: () => chain, onUpdate: () => chain }
  return {
    Gesture: { Simultaneous: () => ({}), Native: () => ({}), Pinch: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))
vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'ChatMessage' }))
vi.mock('./MobileNativeChatTurnStatus', () => ({ MobileNativeChatTurnActivity: 'LiveStatus' }))
vi.mock('./MobileNativeChatComposer', () => ({ MobileNativeChatComposer: 'Composer' }))
vi.mock('./MobileNativeChatQueuedMessages', () => ({ MobileNativeChatQueuedMessages: 'Queued' }))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))

const STOP_ROW = `stopped-before-start:orca:${NEVER_OPENED}`

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the overlay reads only these members of the image attachments, none of which this test exercises.
const OVERLAY_IMAGES = {
  sendNativeChat: async () => true,
  attachImage: async () => {},
  attachments: [],
  removeAttachment: () => {},
  isAttaching: false
} as unknown as Parameters<typeof MobileNativeChatOverlay>[0]['images']

const HOST_SUPPORT = {
  promptCancel: true,
  questionAnswers: true,
  queuedMessages: true,
  statusFeed: true,
  quietRepeatedStop: true
}

type Phone = {
  renderer: ReactTestRenderer
  transcript: (event: AgentSessionSubscribeEvent) => void
  status: (stopping: boolean) => void
  /** The phone's own send of the never-opened message, answered before its row streams in. */
  send: () => void
  read: () => string
  /** The ids the overlay's chat view hands its FlatList. */
  listed: () => string[]
}

const mounted: ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount())
  }
})

async function mountPhone(): Promise<Phone> {
  const listeners = new Map<string, (value: unknown) => void>()
  const client: RpcClient = {
    sendRequest: async () => ({
      id: 'request',
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime' }
    }),
    subscribe: (method, _params, onData) => {
      listeners.set(method, onData)
      return () => {}
    },
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  let latest: {
    drafts: ReturnType<typeof useMobileNativeChatDrafts>
    shown: string
  } | null = null
  function Harness(): ReturnType<typeof createElement> {
    const session = useMobileStructuredAgentSession({
      client,
      sessionId: STOP_JOURNAL_SESSION,
      sourceIdentity: 'host\0workspace',
      enabled: true,
      connected: true,
      agent: 'codex',
      hostSupport: HOST_SUPPORT,
      onSendError: () => {}
    })
    const messages = session.session.messages
    const drafts = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'workspace',
      tabId: 'tab',
      sessionId: STOP_JOURNAL_SESSION,
      messages,
      transcriptSettled: session.session.status === 'ready'
    })
    const { data } = buildMobileNativeChatTransientData({
      messages,
      folded: foldMobileNativeChatMessages(messages),
      streaming: null,
      pending: drafts.pending,
      imagePreviewsByMessageId: drafts.imagePreviewsByMessageId
    })
    const turns = useMobileNativeChatTurnDisclosure({
      messages: data,
      enabled: true,
      isWorking: session.isWorking,
      workingStartedAt: session.workingStartedAt,
      settledTurns: session.settledTurns,
      turnJournal: session.turnJournal,
      thinking: session.turnIndicator.thinking,
      activityText: session.turnIndicator.activityText,
      stopping: session.turnIndicator.stopping,
      scopeKey: 'host\0workspace\0tab'
    })
    const active =
      turns.active === null ? 'none' : turns.active.workedSeconds === null ? 'live' : 'worked'
    latest = {
      drafts,
      shown: JSON.stringify({
        working: session.isWorking,
        stopping: session.turnIndicator.stopping,
        data: data.map((row) => [row.id, row.role, row.stoppedBeforeStart === true, row.blocks]),
        list: turns.listMessages.map((row, index) => {
          const status = turns.resolveRow(index, row).turnStatus
          return [
            row.id,
            status === null ? '-' : status.workedSeconds === null ? 'live' : status.workedSeconds
          ]
        }),
        waiting: turns.waitingRows.map((row) => row.item.id),
        active
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the overlay reads only these controller members, which the controller builds from the same two hooks.
    const controller = {
      showNativeChat: true,
      nativeChatSession: session.session,
      nativeChatAgent: 'codex',
      nativeChatAgentWorking: session.isWorking,
      nativeChatCanStop: false,
      nativeChatStructured: true,
      nativeChatTurnIndicator: session.turnIndicator,
      nativeChatWorkingStartedAt: session.workingStartedAt,
      nativeChatSettledTurns: session.settledTurns,
      nativeChatTurnJournal: session.turnJournal,
      nativeChatStreamLive: session.isWorking,
      nativeChatStreamScopeKey: 'host\0workspace\0tab',
      chatPending: drafts.pending,
      chatImagePreviewsByMessageId: drafts.imagePreviewsByMessageId,
      chatComposerText: drafts.composerText,
      setChatComposerText: drafts.setComposerText,
      getChatComposerEditGeneration: drafts.getComposerEditGeneration,
      nativeChatQueued: session.queued
    } as unknown as MobileNativeChatController
    return createElement(MobileNativeChatOverlay, {
      controller,
      onOpenFile: () => {},
      images: OVERLAY_IMAGES,
      onMicPress: () => {},
      micActive: false,
      dictationMode: 'toggle',
      onMicPressIn: () => {},
      onMicPressOut: () => {},
      inputLockReason: null,
      sendErrorMessage: null,
      onClearSendError: () => {},
      sendSurfaceId: 'host\0workspace\0tab',
      getSendCompletionGeneration: () => 0,
      keyboardInset: 0
    })
  }
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  mounted.push(renderer!)
  await vi.waitFor(() => expect(listeners.get('agentSession.subscribe')).toBeDefined())
  await vi.waitFor(() => expect(listeners.get('agentSession.subscribeStatus')).toBeDefined())
  return {
    renderer: renderer!,
    transcript: (event) =>
      act(() => listeners.get('agentSession.subscribe')!(structuredClone(event))),
    status: (stopping) => {
      const event: AgentSessionStatusEvent = {
        type: 'status',
        session: {
          sessionId: STOP_JOURNAL_SESSION,
          workspaceId: 'workspace',
          agent: 'codex',
          status: stopping ? 'working' : 'idle',
          latestPrompt: '',
          updatedAt: 0,
          ...(stopping ? { stopping: true } : {})
        }
      }
      act(() => listeners.get('agentSession.subscribeStatus')!(event))
    },
    send: () => {
      const origin = latest!.drafts.captureSendOrigin(NEVER_OPENED)!
      act(() => latest!.drafts.acceptSend(origin, NEVER_OPENED))
    },
    read: () => latest!.shown,
    listed: () => {
      const data: unknown = renderer!.root.find((node) => String(node.type) === 'FlatList').props
        .data
      return Array.isArray(data) ? data.map((row: { id: string }) => row.id) : []
    }
  }
}

describe("the phone's hooks, from merged frames and from a fresh snapshot", () => {
  const journal = stopJournal(8)
  const last = journal.rows.length
  const stoppingAt = (upTo: number): boolean =>
    journal.stopping.some((window) => upTo >= window.from && upTo <= window.until)

  const lastRemoval = journal.rows.findLast(
    (row) => row.kind === 'tombstone' && row.stopEvent === undefined
  )!.seq

  // Subscribed before the history's last dropped status, before the turn a send was made into
  // while stopping, and just before the send.
  it.each([lastRemoval - 3, journal.neverOpenedSent - 30, journal.neverOpenedSent - 1])(
    'show the same list after every frame, subscribed at row %i',
    async (start) => {
      const live = await mountPhone()
      live.transcript(journal.snapshotAt(start))
      live.status(stoppingAt(start))
      let cursor = { epoch: 'epoch-1', sequence: start }
      let fence = journal.fenceAt(start)
      const differing: string[] = []
      for (let upTo = start + 1; upTo <= last; upTo += 1) {
        if (upTo === journal.neverOpenedSent) {
          live.send()
          expect(live.read()).toContain('"pending-')
        }
        for (const event of journal.framesTo({ cursor, fence }, upTo)) {
          live.transcript(event)
          fence = event.type === 'end' ? fence : (event.fence ?? fence)
        }
        cursor = { epoch: 'epoch-1', sequence: upTo }
        live.status(stoppingAt(upTo))
        if (upTo === journal.takenBack - 1) {
          // The never-opened send's own Stop, still settling.
          expect(live.read()).toContain('"stopping":true')
        }
        const fresh = await mountPhone()
        fresh.transcript(journal.snapshotAt(upTo))
        fresh.status(stoppingAt(upTo))
        if (live.read() !== fresh.read()) {
          differing.push(`frame through ${upTo}`)
        }
        if (upTo >= journal.takenBack && !live.listed().includes(STOP_ROW)) {
          differing.push(`no stop row in the merged list through ${upTo}`)
        }
        if (upTo >= journal.takenBack && !fresh.listed().includes(STOP_ROW)) {
          differing.push(`no stop row in the fresh list at ${upTo}`)
        }
        act(() => fresh.renderer.unmount())
        mounted.splice(mounted.indexOf(fresh.renderer), 1)
      }
      expect(differing).toEqual([])
    },
    60_000
  )
})
