import { isRemoteRuntimeBinaryFrameWithinLimit } from '../../shared/remote-runtime-memory-limits'
import type { RpcBinarySender } from './rpc/rpc-binary-sender'

// Why: the E2EE channel closes the socket (1013) on an over-limit binary frame, and the
// screencast producer reads `false` as backpressure and retries the identical frame. Reporting
// an over-limit frame as handled drops it so the stream advances instead of retrying forever.
export function sendRemoteBrowserScreencastFrame(
  sendBinary: RpcBinarySender,
  bytes: Uint8Array<ArrayBufferLike>
): boolean {
  if (!isRemoteRuntimeBinaryFrameWithinLimit(bytes)) {
    return true
  }
  return sendBinary(bytes, { dropWhenBacklogged: true }) !== false
}
