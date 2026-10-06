import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { buildAskAnswerKeys, type AskPrompt } from '../../../src/shared/native-chat-ask'
import {
  visible,
  handleRef,
  baseTab,
  permissionTab,
  response,
  render,
  reset,
  unmount,
  sendButton,
  permissionAction,
  questionOption,
  getController,
  askCancel
} from './__mocks__/mobile-prompt-controller'

const client: RpcClient = {
  sendRequest: vi.fn<RpcClient['sendRequest']>(),
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}

beforeEach(() => {
  vi.mocked(client.sendRequest).mockReset().mockResolvedValue(response())
  reset(client)
})
afterEach(async () => {
  await unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function option() {
  const found = questionOption()
  if (!found) {
    throw new Error('question choice missing')
  }
  return found
}

describe('prompt cards through the production controller, send contract and view', () => {
  it.each(['lost', 'legacy', 'unverifiable'])(
    'keeps a question actionable after %s acknowledgment',
    async (mode) => {
      vi.mocked(client.sendRequest).mockImplementation(async (method, params) => {
        if (
          method === 'terminal.send' &&
          typeof params === 'object' &&
          params !== null &&
          'enter' in params &&
          params.enter === true
        ) {
          if (mode === 'lost') {
            throw markRpcDeliveryUnknown(new Error('lost acknowledgment'))
          }
          return response(mode === 'legacy', mode === 'legacy' ? 'legacy' : 'unverifiable')
        }
        return response()
      })
      await render()
      await act(async () => {
        await option().props.onPress()
      })
      expect(getController().nativeChatQuestion).not.toBe(null)
      expect(sendButton().props.disabled).toBe(true)
      expect(option().props.disabled).toBeFalsy()
    }
  )

  it('hides the acknowledged question and enables ordinary Send with stale host status', async () => {
    await render()
    await act(async () => {
      await option().props.onPress()
    })
    expect(getController().nativeChatQuestion).toBe(null)
    expect(sendButton().props.disabled).toBe(false)
    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ requireWriteSettlement: true, enter: true }),
      expect.any(Object)
    )
  })

  it('finishes an older-host selector once without dismissing its unacknowledged card', async () => {
    vi.useFakeTimers()
    const prompt: AskPrompt = {
      questions: [{ question: 'Answer?', options: [{ label: 'A' }], multiSelect: false }]
    }
    const selections = [{ indices: [], other: 'custom answer' }]
    const groups = buildAskAnswerKeys(prompt, selections)
    vi.mocked(client.sendRequest).mockResolvedValue(response(true, 'legacy'))
    await render({
      tab: {
        ...baseTab,
        agentStatus: {
          ...baseTab.agentStatus,
          lastAssistantMessage: '',
          toolName: 'AskUserQuestion',
          interactivePrompt: JSON.stringify(prompt)
        }
      }
    })
    let pending: Promise<boolean> | undefined
    act(() => {
      pending = getController().handleNativeChatAnswerAsk(prompt, selections)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
      await expect(pending).resolves.toBe(false)
    })
    const writes = vi
      .mocked(client.sendRequest)
      .mock.calls.filter(([method]) => method === 'terminal.send')
      .map(([, params]) => params)
    expect(writes).toEqual(
      groups.map((group) =>
        expect.objectContaining({
          text: 'raw' in group ? group.raw : group.text,
          enter: false,
          requireWriteSettlement: true
        })
      )
    )
    expect(getController().nativeChatAsk).not.toBe(null)
    expect(sendButton().props.disabled).toBe(true)
  })

  it.each(['refused', 'unverifiable', 'legacy'] as const)(
    'retains permission choices on %s',
    async (mode) => {
      vi.mocked(client.sendRequest).mockResolvedValue(response(mode === 'legacy', mode))
      await render({ tab: permissionTab })
      await act(async () => {
        await permissionAction().props.onPress()
      })
      expect(getController().nativeChatPermission).not.toBe(null)
      expect(permissionAction().props.disabled).toBe(false)
      expect(sendButton().props.disabled).toBe(true)
      expect(client.sendRequest).toHaveBeenCalledWith(
        'terminal.send',
        expect.objectContaining({ requireWriteSettlement: true, enter: false, text: '\x1b' }),
        expect.any(Object)
      )
    }
  )

  it.each(['permission', 'ask'])(
    'acknowledges the same pending %s after a view-only toggle',
    async (kind) => {
      const tab =
        kind === 'permission'
          ? permissionTab
          : {
              ...baseTab,
              agentStatus: {
                ...baseTab.agentStatus,
                lastAssistantMessage: '',
                toolName: 'AskUserQuestion',
                interactivePrompt: JSON.stringify({
                  questions: [
                    {
                      question: 'Pick destination?',
                      options: [{ label: 'East' }, { label: 'West' }]
                    }
                  ]
                })
              }
            }
      let finish: (reply: RpcResponse) => void = () => {
        throw new Error('write not started')
      }
      vi.mocked(client.sendRequest).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      await render({ tab })
      let action: Promise<boolean> | undefined
      act(() => {
        action = kind === 'permission' ? permissionAction().props.onPress() : askCancel()
      })
      visible.value = false
      await render({ tab })
      visible.value = true
      await render({ tab })
      await act(async () => {
        finish(response())
        await action
      })
      expect(getController().nativeChatPermission).toBe(null)
      expect(getController().nativeChatAsk).toBe(null)
      expect(sendButton().props.disabled).toBe(false)
    }
  )

  it.each(['prompt', 'session', 'PTY', 'tab', 'clear'])(
    'drops an accepted result after real %s replacement',
    async (replacement) => {
      let finish: (reply: RpcResponse) => void = () => {
        throw new Error('write not started')
      }
      vi.mocked(client.sendRequest).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      await render({ tab: permissionTab })
      act(() => {
        void permissionAction().props.onPress()
      })
      const agentStatus: NonNullable<typeof permissionTab.agentStatus> = {
        ...permissionTab.agentStatus
      }
      if (replacement === 'prompt') {
        agentStatus.stateStartedAt = 20
      }
      if (replacement === 'session') {
        agentStatus.providerSession = { id: 'session-2', key: 'session_id' }
      }
      if (replacement === 'PTY') {
        handleRef.current = 'term-2'
      }
      if (replacement === 'clear') {
        await render({
          tab: { ...baseTab, agentStatus: { ...baseTab.agentStatus, state: 'working' } }
        })
      }
      await render({
        tab: { ...permissionTab, agentStatus },
        tabId: replacement === 'tab' ? 'tab-2' : 'tab-1'
      })
      await act(async () => {
        finish(response())
      })
      expect(getController().nativeChatPermission).not.toBe(null)
      expect(permissionAction().props.disabled).toBe(false)
      expect(sendButton().props.disabled).toBe(true)
    }
  )
})
