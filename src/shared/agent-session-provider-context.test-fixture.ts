import type { AgentSessionProviderHandleLink } from './agent-session-provider-handle'
import {
  agentSessionProviderHandleKey,
  claudeProviderHandle,
  codexProviderHandle
} from './agent-session-provider-handle-encoding'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from './agent-session-record.test-fixture'

export function providerContextRecordFixture(
  provider: 'claude' | 'codex',
  contextLengths: readonly number[] = [2, 1]
) {
  const chain: AgentSessionProviderHandleLink[] = []
  for (const [context, length] of contextLengths.entries()) {
    for (let offset = 0; offset < length; offset += 1) {
      const fence = chain.length + 1
      const handle =
        provider === 'claude'
          ? claudeProviderHandle(`context-${context}`, `leaf-${fence}`)
          : codexProviderHandle(`context-${context}`)
      const previous = chain.at(-1)
      chain.push({
        linkId: `link-${fence}`,
        handle,
        origin: offset === 0 ? 'created' : 'resumed',
        mintedAtFence: fence,
        observedAt: fence * 1000,
        ...(offset === 0 && previous
          ? {
              replaces: {
                key: agentSessionProviderHandleKey(previous.handle),
                reason: context % 2 === 0 ? 'context-cleared' : 'restore-failed',
                replacedAt: fence * 1000
              }
            }
          : {})
      })
    }
  }
  const head = chain.at(-1)
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      runtimeFence: head?.mintedAtFence ?? 0,
      provenHandleLinkId: head?.linkId ?? null
    })
  )
  return {
    ...record,
    provider,
    accountHome:
      provider === 'claude'
        ? record.accountHome
        : {
            variable: 'CODEX_HOME',
            path: '/home/user/.codex'
          },
    providerHandleChain: chain
  }
}
