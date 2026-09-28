import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import type { AgentSessionConversationCommandResult } from '../../../../shared/agent-session-conversation-command'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import { sendStructuredConversationCommand } from './structured-conversation-command-send'

const START_FAILED: AgentSessionFailureFact = { kind: 'startFailed' }
const COMPACTION_FAILED: AgentSessionFailureFact = {
  kind: 'compactionFailed',
  detail: { text: 'Context is too short', audience: 'person' }
}

// The facts a /clear whose new conversation did not start, and a /compact, can carry.
const CLEAR_FACTS: AgentSessionFailureFact[] = [
  START_FAILED,
  { kind: 'startFailed', refusal: { code: 'structured_agent_session_unsupported' } },
  {
    kind: 'startFailed',
    refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } }
  },
  { kind: 'providerStartFailed' },
  { kind: 'notSignedIn' },
  { kind: 'historyTooLarge' },
  { kind: 'managedAccountUnsupported' },
  { kind: 'managedAccountEnvOverride' },
  { kind: 'accountSwitchInProgress' }
]
const COMPACT_FACTS: AgentSessionFailureFact[] = [
  COMPACTION_FAILED,
  { kind: 'compactionFailed' },
  { kind: 'compactionUnconfirmed' }
]

// What the host returns: its English, worded with the context it uses, beside the fact.
function hostResult(
  command: 'clear' | 'compact',
  failure: AgentSessionFailureFact,
  provider: 'claude' | 'codex' = 'claude'
): AgentSessionConversationCommandResult {
  const context =
    command === 'clear'
      ? { agentName: TUI_AGENT_DISPLAY_NAMES[provider], command: 'clear' as const }
      : {}
  const words = agentSessionFailureWords(failure, { ...context, surface: 'row' })
  return { command, state: 'completed', error: words.text, failure: words.failure }
}

async function sent(
  result: AgentSessionConversationCommandResult,
  provider: 'claude' | 'codex' = 'claude'
) {
  return sendStructuredConversationCommand({
    command: result.command,
    agentName: structuredAgentLabel(provider),
    pending: { current: false },
    blocked: false,
    send: async () => ({ kind: 'done', value: result })
  })
}

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('the line under the composer after a conversation command failed', () => {
  it('says in English exactly what the host wrote, for every failure a command reports', async () => {
    for (const provider of ['claude', 'codex'] as const) {
      for (const result of [
        ...CLEAR_FACTS.map((fact) => hostResult('clear', fact, provider)),
        ...COMPACT_FACTS.map((fact) => hostResult('compact', fact, provider))
      ]) {
        expect(await sent(result, provider)).toEqual({ accepted: false, error: result.error })
      }
    }
    // The host's own tests pin these sentences.
    expect((await sent(hostResult('clear', START_FAILED, 'codex'), 'codex')).error).toBe(
      "Codex couldn't start. Run /clear again."
    )
    expect((await sent(hostResult('clear', CLEAR_FACTS[1], 'codex'), 'codex')).error).toBe(
      "Codex couldn't start. Start a new chat to continue."
    )
    expect((await sent(hostResult('clear', { kind: 'notSignedIn' }, 'codex'), 'codex')).error).toBe(
      'Codex is not signed in for the selected account. Sign in, then run /clear again.'
    )
  })

  it("says it in the reader's language", async () => {
    await i18n.changeLanguage('fr')
    expect((await sent(hostResult('clear', START_FAILED))).error).toBe(
      "Claude n'a pas pu démarrer. Relancez /clear."
    )
    expect((await sent(hostResult('compact', COMPACTION_FAILED))).error).toBe(
      'La compaction a échoué : Context is too short.'
    )
    await i18n.changeLanguage('ja')
    expect((await sent(hostResult('clear', START_FAILED))).error).toBe(
      'Claude を起動できませんでした。/clear をもう一度実行してください。'
    )
  })

  it("shows an older host's sentence as written when it sent no fact", async () => {
    await i18n.changeLanguage('fr')
    expect(
      await sent({
        command: 'clear',
        state: 'completed',
        error: "Claude couldn't start. Run /clear again."
      })
    ).toEqual({ accepted: false, error: "Claude couldn't start. Run /clear again." })
    expect(await sent({ command: 'compact', state: 'completed' })).toEqual({
      accepted: true,
      error: null
    })
  })
})
