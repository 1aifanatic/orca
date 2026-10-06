import { setTimeout as delay } from 'node:timers/promises'
import { OpenCodeHttpError } from './serve/http-response'
import type { OpenCodeNativeSession } from './serve/native-protocol'
import type { OpenCodeSession } from './opencode-structured-session-state'
import { openCodeChildPermissionRules } from './opencode-structured-permission-policy'

/** A failure to locate an asking child is retried, never mistaken for an unrelated session. */
export async function proveOpenCodeSessionAncestry(
  session: OpenCodeSession,
  nativeId: string,
  isCurrent: () => boolean
): Promise<boolean> {
  const { translator, client, root } = session
  if (!translator || !client || !root || !isCurrent()) {
    return false
  }
  if (translator.ownsSession(nativeId)) {
    return true
  }
  const signal = AbortSignal.any([session.streamAbort.signal, AbortSignal.timeout(10_000)])
  const chain: OpenCodeNativeSession[] = []
  const seen = new Set<string>()
  let cursor: string | undefined = nativeId
  for (let depth = 0; cursor && depth <= 8; depth += 1) {
    if (!isCurrent()) {
      return false
    }
    if (translator.ownsSession(cursor)) {
      for (const entry of chain.toReversed()) {
        if (client.version.major === 1) {
          await client.patchPermissions(
            entry.id,
            openCodeChildPermissionRules({
              major: 1,
              parentRules: session.launch.permissions,
              childRules: entry.permission ?? []
            }),
            signal
          )
        }
        if (!isCurrent()) {
          return false
        }
        translator.registerSession(entry)
      }
      return translator.ownsSession(nativeId)
    }
    if (seen.has(cursor)) {
      return false
    }
    seen.add(cursor)
    let loaded: OpenCodeNativeSession | undefined
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        loaded = await client.load(cursor, signal)
        break
      } catch (error) {
        if (!isCurrent()) {
          return false
        }
        if (attempt === 2 || signal.aborted) {
          throw error
        }
        await delay(250, undefined, { signal })
      }
    }
    if (!isCurrent()) {
      return false
    }
    if (!loaded) {
      throw new OpenCodeHttpError('invalid-response', 'OpenCode child could not be located')
    }
    if (!loaded.parentID) {
      return false
    }
    chain.push(loaded)
    cursor = loaded.parentID
  }
  throw new OpenCodeHttpError('capacity', 'OpenCode child ancestry exceeds the resolution limit')
}
