import { useCallback, useMemo } from 'react'
import type { NativeChatDeliveryStatus } from '../../../src/shared/native-chat-pending-delivery'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import { nativeChatSessionPageRead } from './mobile-session-read-operations'

export async function readMobileNativeChatDeliveryTranscript(
  client: RpcClient | null,
  sessionId: string | null,
  transcriptPath: string | null
): Promise<NativeChatMessage[] | null> {
  if (!client || !sessionId) {
    return null
  }
  const response = await nativeChatSessionPageRead.request(client, {
    agent: 'claude',
    sessionId,
    limit: 500,
    ...(transcriptPath ? { transcriptPath } : {})
  })
  const result = nativeChatSessionPageRead.interpret(response)
  if (!result.accepted) {
    return null
  }
  const value = result.value
  if (
    !value ||
    typeof value !== 'object' ||
    !('messages' in value) ||
    !Array.isArray(value.messages)
  ) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the nativeChat reader returns the host's message array, as on the existing history-page path.
  return value.messages as NativeChatMessage[]
}

export function useMobileNativeChatDeliveryTracking(
  client: RpcClient | null,
  sessionId: string | null,
  transcriptPath: string | null,
  enabled: boolean,
  status: NativeChatDeliveryStatus | null | undefined
) {
  const readTranscript = useCallback(
    () => readMobileNativeChatDeliveryTranscript(client, sessionId, transcriptPath),
    [client, sessionId, transcriptPath]
  )
  return useMemo(
    () => (enabled ? { status, readTranscript } : undefined),
    [enabled, status, readTranscript]
  )
}
