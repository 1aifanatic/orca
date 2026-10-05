import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../../../../shared/node-bounded-json-stringify'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../../shared/remote-runtime-memory-limits'
import type { NativeChatTurnLifecycle } from '../../../../shared/native-chat-types'
import { successResponse } from '../errors'

export const NATIVE_CHAT_FRAME_TOO_LARGE_ERROR = 'This chat is too large to show on this device'

// The response's runtimeId is a UUID; this covers it with room to spare.
const RUNTIME_ID_RESERVE_BYTES = 64

/** Bytes the result may take once the dispatcher wraps it into the phone's response frame. */
function resultByteLimit(requestId: string | undefined): number {
  const shell = JSON.stringify({
    ...successResponse(requestId ?? '', { runtimeId: '' }, null),
    streaming: true
  })
  return (
    REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES -
    (Buffer.byteLength(shell, 'utf8') - 'null'.length) -
    RUNTIME_ID_RESERVE_BYTES
  )
}

function fitsWithin(value: unknown, maxBytes: number): boolean {
  try {
    stringifyJsonWithinByteLimit(value, maxBytes)
    return true
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      return false
    }
    throw error
  }
}

/** The phone socket closes the whole connection on a frame over its JSON cap, so a native-chat
 *  result must fit before it is sent: as-is, else without the optional lifecycle, else not at all. */
export function admitNativeChatMobileResult<T extends { lifecycle?: NativeChatTurnLifecycle }>(
  result: T,
  requestId: string | undefined
): T | null {
  const maxBytes = resultByteLimit(requestId)
  if (fitsWithin(result, maxBytes)) {
    return result
  }
  if (result.lifecycle === undefined) {
    return null
  }
  const withoutLifecycle = { ...result }
  delete withoutLifecycle.lifecycle
  return fitsWithin(withoutLifecycle, maxBytes) ? withoutLifecycle : null
}
