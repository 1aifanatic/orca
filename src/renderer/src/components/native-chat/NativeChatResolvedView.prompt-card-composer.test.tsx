// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentStatusPayload } from '../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'
import type * as RuntimeTerminalInspectionModule from '@/runtime/runtime-terminal-inspection'

type RuntimeTerminalInspection = typeof RuntimeTerminalInspectionModule

const MESSAGE = 'please also run lint'
const retained = vi.hoisted((): { session: NativeChatLiveSession | null } => ({ session: null }))
const composer = vi.hoisted(() => ({ mounts: 0, typed: vi.fn<(text: string) => boolean>() }))
const pty = vi.hoisted(() => ({
  verified: vi.fn<(settings: unknown, id: string, data: string) => Promise<boolean>>(),
  raw: vi.fn<(settings: unknown, id: string, data: string) => boolean>()
}))
vi.mock('./use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: () => retained.session
}))
vi.mock('@/runtime/runtime-terminal-inspection', async (importOriginal) => ({
  ...(await importOriginal<RuntimeTerminalInspection>()),
  sendRuntimePtyInputVerified: pty.verified,
  sendRuntimePtyInput: pty.raw
}))
// Stand-in field over the production send lifecycle, queue and observed writes, wired as the
// composer wires them.
vi.mock('./NativeChatComposer', async () => {
  const { forwardRef, useEffect, useImperativeHandle } = await import('react')
  const { useNativeChatSendLifecycle } = await import('./use-native-chat-send-lifecycle')
  const { sendNativeChatMessage } = await import('./native-chat-runtime-send')
  return {
    NativeChatComposer: forwardRef<NativeChatComposerHandle, NativeChatComposerProps>(
      function StandInComposer(props, ref) {
        useEffect(() => {
          composer.mounts += 1
        }, [])
        useImperativeHandle(ref, () => ({
          focus: () => true,
          insertTypedText: composer.typed,
          handlePasteEvent: () => {},
          pasteFromClipboard: () => {},
          contains: () => false
        }))
        const lifecycle = useNativeChatSendLifecycle(
          props.terminalTabId,
          props.targetPtyId,
          props.onOptimisticSendCanceled,
          {
            inputOwnedByCard: props.inputOwnedByCard === true,
            onPendingSendRetired: props.optimisticSendOutcome?.reject
          }
        )
        const send = (): void => {
          let pendingId: string | undefined
          const handle = sendNativeChatMessage(null, props.targetPtyId ?? '', MESSAGE, {
            onWriteRejected: () => {
              if (pendingId) {
                props.optimisticSendOutcome?.reject(pendingId)
              }
            }
          })
          pendingId = props.onOptimisticSend?.(MESSAGE)
          lifecycle.trackPendingSend(handle, pendingId)
        }
        return (
          <button type="button" data-testid="composer-send" onClick={send}>
            send
          </button>
        )
      }
    )
  }
})

const { NativeChatResolvedView } = await import('./NativeChatResolvedView')
const { TooltipProvider } = await import('@/components/ui/tooltip')
const { useAppStore } = await import('../../store')
const { installNativeChatMessageListTestViewport } =
  await import('./native-chat-message-list-test-viewport')
const { resetNativeChatPtySendQueuesForTests } = await import('./native-chat-runtime-send')
const { clearNativeChatPromptDismissalsForTests } = await import('./native-chat-prompt-dismissals')

const paneKey = 'tab-hidden:leaf-hidden'
const approval = JSON.stringify({ approval: { tool: 'Bash', summary: 'npm test' } })
let restoreViewport = (): void => {}

const userTurn: NativeChatMessage = {
  id: 'user-1',
  role: 'user',
  blocks: [{ type: 'text', text: 'Clean the build' }],
  timestamp: 1,
  source: 'transcript'
}

function setStatus(payload: Omit<AgentStatusPayload, 'prompt' | 'agentType'>): void {
  useAppStore
    .getState()
    .setAgentStatus(paneKey, { prompt: 'Clean the build', agentType: 'claude', ...payload })
}

function renderPane(): void {
  render(
    <TooltipProvider>
      <NativeChatResolvedView
        paneKey={paneKey}
        agent="claude"
        sessionId="session-hidden"
        transcriptPath={null}
        isVisible
        isFocusedGroup
        targetPtyId="pty-hidden"
        terminalTabId="tab-hidden"
        ownsTabWideLaunchDraft={false}
      />
    </TooltipProvider>
  )
}

function rootElement(): Element {
  const root = document.querySelector('[data-native-chat-root="true"]')
  if (!root) {
    throw new Error('chat root missing')
  }
  return root
}

beforeEach(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
  resetNativeChatPtySendQueuesForTests()
  clearNativeChatPromptDismissalsForTests()
  composer.mounts = 0
  composer.typed.mockReset().mockReturnValue(true)
  pty.verified.mockReset().mockResolvedValue(true)
  pty.raw.mockReset().mockReturnValue(true)
  useAppStore.setState({ agentStatusByPaneKey: {}, nativeChatLaunchPromptByTabId: {} })
  retained.session = {
    messages: [userTurn],
    status: 'working',
    sessionId: 'session-hidden',
    agent: 'claude',
    hookAwaitingInput: false,
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
})

afterEach(() => {
  cleanup()
  resetNativeChatPtySendQueuesForTests()
  restoreViewport()
  useAppStore.setState({ agentStatusByPaneKey: {}, nativeChatLaunchPromptByTabId: {} })
})

describe('a prompt card hides the composer without unmounting it', () => {
  it('keeps an in-flight message visible and never submits it into the approval', async () => {
    setStatus({ state: 'working' })
    renderPane()
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-send'))
    })
    expect(pty.verified.mock.calls.map((call) => call[2]).join('')).toContain(MESSAGE)

    // The approval arrives inside the body-to-Enter gap.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      setStatus({ state: 'waiting', interactivePrompt: approval })
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900))
    })

    expect(document.querySelector('[data-native-chat-approval-card="true"]')).not.toBeNull()
    expect(pty.verified.mock.calls.map((call) => call[2])).not.toContain('\r')
    // Only the pre-body clear: retiring the send types nothing under the card.
    expect(pty.raw.mock.calls.map((call) => call[2])).toEqual(['\x15'])
    expect(screen.getByTestId('composer-send').closest('[hidden]')).not.toBeNull()
    expect(screen.getAllByText(MESSAGE).length).toBeGreaterThan(0)
    expect(screen.getByText('Message not sent')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    })
    expect(screen.getByTestId('composer-send').closest('[hidden]')).toBeNull()
    expect(composer.mounts).toBe(1)
  })

  it('routes no typing to the hidden composer until the card is answered', async () => {
    setStatus({ state: 'waiting', interactivePrompt: approval })
    renderPane()

    fireEvent.keyDown(rootElement(), { key: 'x' })
    expect(composer.typed).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    })
    fireEvent.keyDown(rootElement(), { key: 'x' })
    expect(composer.typed).toHaveBeenCalledExactlyOnceWith('x')
    expect(composer.mounts).toBe(1)
  })
})
