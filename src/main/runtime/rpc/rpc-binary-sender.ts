export type RpcBinarySendOptions = {
  // Why: a lossy stream resends its newest frame later, so queueing stale frames behind a backlog only delays it.
  dropWhenBacklogged?: boolean
}

/** Returns false when the frame was not sent or queued. */
export type RpcBinarySender = (
  bytes: Uint8Array<ArrayBufferLike>,
  options?: RpcBinarySendOptions
) => boolean | void
