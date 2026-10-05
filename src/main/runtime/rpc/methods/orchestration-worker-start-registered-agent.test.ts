// An orchestration worker for a registered agent (Grok) follows the same structured-chat setting as
// Claude and Codex: a chat when the user's default is a structured chat, a terminal when it is off.

import { describe, expect, it } from 'vitest'
import { decideWorkerStartMode } from './orchestration-worker-start-mode'

const STRUCTURED_PREFERENCE = {
  experimentalNativeChat: true,
  experimentalStructuredNativeChat: true,
  openAgentTabsInChatByDefault: true
} as const

describe('a Grok worker and the structured-chat setting', () => {
  it('starts as a structured chat while the setting is on', () => {
    expect(
      decideWorkerStartMode({ params: { agent: 'grok' }, settings: STRUCTURED_PREFERENCE })
    ).toMatchObject({ mode: 'structured', reason: 'user_default' })
  })

  it('starts as a terminal agent while the setting is off, as Claude does', () => {
    for (const agent of ['grok', 'claude']) {
      expect(
        decideWorkerStartMode({
          params: { agent },
          settings: { ...STRUCTURED_PREFERENCE, experimentalStructuredNativeChat: false }
        })
      ).toMatchObject({ mode: 'terminal', preferred: 'terminal', reason: 'user_default' })
    }
  })
})
