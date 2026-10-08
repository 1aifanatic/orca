import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import { getAgentSessionOptionCatalog } from '../../../src/shared/agent-session-option-catalog'
import type {
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../src/shared/agent-session-wire'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue
} from '../../../src/shared/native-chat-session-options'
import {
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'
import { structuredAgentSessionOptionPicks } from '../../../src/shared/structured-agent-session-option-picks'
import type { RpcClient } from '../transport/rpc-client'
import {
  callAgentSession,
  type StructuredAgentSessionMutate
} from './mobile-structured-agent-session-rpc'
import { persistMobileStructuredOptionPicks } from './mobile-native-chat-session-option-persistence'
import { encodeStructuredAgentSessionOptionValue } from '../../../src/shared/structured-agent-session-option-codec'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../src/shared/agent-chat-permission-mode'
import type { MobileNativeChatPermissionPickerState } from './MobileNativeChatPermissionPicker'

type StructuredOptionsController = {
  /** Null where the host offers no permission picker for this chat. */
  permissionPicker: MobileNativeChatPermissionPickerState | null
  optionPickerRequest: { id: string; sequence: number } | null
  conversationCommands: readonly AgentSessionConversationCommand[]
  optionSnapshot: SessionOptionDescriptor[]
  optionSurface: SessionOptionsSurface
  pendingOptionId: string | null
  setStructuredOption: (id: string, value: SessionOptionValue) => Promise<boolean>
  invokeStructuredOption: (id: string) => Promise<boolean>
}

export function useMobileStructuredAgentOptions(args: {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  fence: number | null
  connected?: boolean
  turnId?: string | null
  providerPhase?: string | null
  permissionMode?: string | null
  unloadedTurnRevisions?: number
  mutate: StructuredAgentSessionMutate
}): StructuredOptionsController {
  const {
    agent,
    client,
    enabled,
    fence,
    mutate,
    sessionId,
    connected = true,
    turnId,
    providerPhase,
    permissionMode,
    unloadedTurnRevisions
  } = args
  const [optionState, setOptionState] = useState(() =>
    createStructuredAgentSessionOptionState(agent ?? 'codex')
  )
  const optionStateRef = useRef(optionState)
  const activeOptionRecordRef = useRef(optionState.record)
  const pendingOptionRef = useRef<string | null>(null)
  const optionMutationGeneration = useRef(0)
  const optionReadGeneration = useRef(0)
  const updateOptionState = useCallback(
    (update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState) => {
      const next = update(optionStateRef.current)
      optionStateRef.current = next
      setOptionState(next)
    },
    []
  )
  const [optionPickerRequest, setOptionPickerRequest] = useState<{
    id: string
    sequence: number
  } | null>(null)
  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
  } | null>(null)
  const optionCatalog = useMemo(
    () => (agent === 'claude' || agent === 'codex' ? getAgentSessionOptionCatalog(agent) : null),
    [agent]
  )

  useEffect(() => {
    const next = createStructuredAgentSessionOptionState(agent ?? 'codex')
    optionMutationGeneration.current += 1
    pendingOptionRef.current = null
    optionStateRef.current = next
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, enabled, fence, sessionId])

  useEffect(() => {
    if (!client || !sessionId || !enabled || !connected || !optionCatalog) {
      return
    }
    let stale = false
    const readGeneration = optionMutationGeneration.current
    const readSequence = ++optionReadGeneration.current
    void callAgentSession<AgentSessionOptionsResult>(client, 'agentSession.options', { sessionId })
      .then((result) => {
        if (
          !stale &&
          optionReadGeneration.current === readSequence &&
          optionMutationGeneration.current === readGeneration
        ) {
          setConversationSupport({ sessionId, commands: result.conversationCommands ?? [] })
          updateOptionState((current) =>
            current.record === activeOptionRecordRef.current
              ? applyStructuredAgentSessionOptions(current, optionCatalog, result)
              : current
          )
        }
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [
    client,
    connected,
    enabled,
    optionCatalog,
    sessionId,
    fence,
    turnId,
    providerPhase,
    permissionMode,
    unloadedTurnRevisions,
    updateOptionState
  ])

  const optionSnapshot = useMemo(
    () => structuredAgentSessionOptionSnapshot(optionState),
    [optionState]
  )

  const setStructuredOption = useCallback(
    async (id: string, value: SessionOptionValue): Promise<boolean> => {
      const currentState = optionStateRef.current
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (
        pendingOptionRef.current !== null ||
        !client ||
        !sessionId ||
        !optionCatalog ||
        encoded === null ||
        !canSetStructuredAgentSessionOption(currentState, id, value)
      ) {
        return false
      }
      const targetRecord = currentState.record
      const mutationGeneration = ++optionMutationGeneration.current
      pendingOptionRef.current = id
      updateOptionState((current) => ({ ...current, pendingId: id }))
      try {
        const result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value: encoded }
        )
        if (
          activeOptionRecordRef.current !== targetRecord ||
          optionMutationGeneration.current !== mutationGeneration
        ) {
          return result.status !== 'rejected'
        }
        if (result.status === 'accepted') {
          const committed = result.value.options ?? { [id]: encoded }
          updateOptionState((current) =>
            current.record === targetRecord && result.sameFence
              ? commitStructuredAgentSessionOptionValues(current, committed)
              : current
          )
          // Only an accepted pick: an `unknown` outcome commits optimistically to the
          // visible record, and remembering one the provider refused would seed a
          // launch the user never chose.
          // The chat's permission mode is its own and never becomes the next chat's default.
          if (
            (agent === 'claude' || agent === 'codex') &&
            id !== AGENT_CHAT_PERMISSION_MODE_OPTION_ID
          ) {
            void persistMobileStructuredOptionPicks({
              client,
              agent,
              picks: structuredAgentSessionOptionPicks(currentState, committed)
            })
          }
          if (result.sameFence) {
            const readSequence = ++optionReadGeneration.current
            void callAgentSession<AgentSessionOptionsResult>(client, 'agentSession.options', {
              sessionId
            })
              .then((refreshed) => {
                if (
                  activeOptionRecordRef.current === targetRecord &&
                  optionReadGeneration.current === readSequence &&
                  optionMutationGeneration.current === mutationGeneration
                ) {
                  updateOptionState((latest) =>
                    latest.record === targetRecord
                      ? applyStructuredAgentSessionOptions(latest, optionCatalog, refreshed)
                      : latest
                  )
                }
              })
              .catch(() => undefined)
          }
          return true
        }
        if (result.status === 'unknown') {
          updateOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOption(current, id, encoded)
              : current
          )
          return true
        }
        return false
      } finally {
        if (
          activeOptionRecordRef.current === targetRecord &&
          optionMutationGeneration.current === mutationGeneration
        ) {
          pendingOptionRef.current = null
          updateOptionState((current) =>
            current.record === targetRecord && current.pendingId === id
              ? { ...current, pendingId: null }
              : current
          )
        }
      }
    },
    [agent, client, mutate, optionCatalog, sessionId, updateOptionState]
  )

  const invokeStructuredOption = useCallback(
    async (id: string) => {
      if (!optionSnapshot.some((entry) => entry.id === id)) {
        return false
      }
      setOptionPickerRequest((current) => ({ id, sequence: (current?.sequence ?? 0) + 1 }))
      return true
    },
    [optionSnapshot]
  )

  const setOption = useCallback(
    async (id: string, value: SessionOptionValue) => {
      await setStructuredOption(id, value)
      return { snapshot: structuredAgentSessionOptionSnapshot(optionStateRef.current) }
    },
    [setStructuredOption]
  )

  const optionSurface = useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshot,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {}
    }),
    [optionSnapshot, setOption]
  )

  const permissionPicker = useMemo<MobileNativeChatPermissionPickerState | null>(
    () =>
      optionState.permission
        ? {
            current: optionState.permission.current,
            supported: optionState.permission.supported,
            pending: optionState.pendingId !== null,
            setMode: (mode) => setStructuredOption(AGENT_CHAT_PERMISSION_MODE_OPTION_ID, mode)
          }
        : null,
    [optionState.pendingId, optionState.permission, setStructuredOption]
  )

  return {
    permissionPicker,
    optionPickerRequest,
    conversationCommands:
      conversationSupport?.sessionId === sessionId ? conversationSupport.commands : [],
    optionSnapshot,
    optionSurface,
    pendingOptionId: optionState.pendingId,
    setStructuredOption,
    invokeStructuredOption
  }
}
