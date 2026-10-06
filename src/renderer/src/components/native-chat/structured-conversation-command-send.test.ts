import { afterEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import type { AgentSessionConversationCommandResult } from '../../../../shared/agent-session-conversation-command'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import {
  sendStructuredConversationCommand,
  structuredConversationCommandHold
} from './structured-conversation-command-send'

const START_FAILED: AgentSessionFailureFact = { kind: 'startFailed' }
const COMPACTION_FAILED: AgentSessionFailureFact = {
  kind: 'compactionFailed',
  detail: { text: 'Context is too short', audience: 'person' }
}

// The facts a command whose conversation did not start can carry: a /clear's new one, or the
// start a /compact waited on.
const START_FACTS: AgentSessionFailureFact[] = [
  START_FAILED,
  { kind: 'restartFailed' },
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
  { kind: 'commandRefused' },
  { kind: 'compactionFailed' },
  { kind: 'compactionUnconfirmed' }
]

// What the host returns: its English, worded with the context it uses, beside the fact.
function hostResult(
  command: 'clear' | 'compact',
  failure: AgentSessionFailureFact,
  provider: 'claude' | 'codex' = 'claude'
): AgentSessionConversationCommandResult {
  const words = agentSessionFailureWords(failure, {
    agentName: TUI_AGENT_DISPLAY_NAMES[provider],
    command,
    surface: 'row'
  })
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
    hold: null,
    untilAheadHandedOver: async () => true,
    startFailures: () => [],
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
        ...START_FACTS.map((fact) => hostResult('clear', fact, provider)),
        ...START_FACTS.map((fact) => hostResult('compact', fact, provider)),
        ...COMPACT_FACTS.map((fact) => hostResult('compact', fact, provider))
      ]) {
        expect(await sent(result, provider)).toEqual({ accepted: false, error: result.error })
      }
    }
    // The host's own tests pin these sentences.
    expect((await sent(hostResult('clear', START_FAILED, 'codex'), 'codex')).error).toBe(
      "Codex couldn't start. Run /clear again."
    )
    expect(
      (await sent(hostResult('compact', { kind: 'restartFailed' }, 'codex'), 'codex')).error
    ).toBe("Codex couldn't restart. Run /compact again.")
    expect((await sent(hostResult('compact', { kind: 'notSignedIn' }), 'claude')).error).toBe(
      'Claude is not signed in for the selected account. Sign in, then run /compact again.'
    )
    expect((await sent(hostResult('clear', START_FACTS[2], 'codex'), 'codex')).error).toBe(
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
    expect((await sent(hostResult('compact', { kind: 'restartFailed' }))).error).toBe(
      "Claude n'a pas pu redémarrer. Relancez /compact."
    )
    expect((await sent(hostResult('compact', { kind: 'managedAccountUnsupported' }))).error).toBe(
      "Tant qu'un compte Claude est ajouté dans WSL, les chats Claude nécessitent un compte Claude Windows. Choisissez-en un ou ajoutez-en un dans les paramètres Comptes Claude, puis relancez /compact."
    )
    await i18n.changeLanguage('ja')
    expect((await sent(hostResult('clear', START_FAILED))).error).toBe(
      'Claude を起動できませんでした。/clear をもう一度実行してください。'
    )
    expect((await sent(hostResult('compact', { kind: 'notSignedIn' }))).error).toBe(
      'Claude は選択したアカウントでサインインしていません。サインインしてから、/compact をもう一度実行してください。'
    )
  })

  it("shows the host's sentence as written when this build cannot read all of its fact", async () => {
    await i18n.changeLanguage('fr')
    const error = "Claude couldn't start. Start a new chat to continue."
    // As a newer host sends them: a refusal code, a refusal reason, and a part this build doesn't know.
    for (const failure of [
      JSON.parse('{ "kind": "startFailed", "refusal": { "code": "agent_session_newer_refusal" } }'),
      JSON.parse(
        '{ "kind": "startFailed", "refusal": { "code": "agent_session_conflict", "details": { "reason": "newerReason" } } }'
      ),
      JSON.parse('{ "kind": "startFailed", "newerPart": { "reason": "unresumable" } }')
    ]) {
      expect(await sent({ command: 'clear', state: 'completed', error, failure })).toEqual({
        accepted: false,
        error
      })
    }
    expect((await sent(hostResult('clear', START_FACTS[2]))).error).toBe(
      "Claude n'a pas pu démarrer. Démarrez un nouveau chat pour continuer."
    )
  })

  it("shows the host's sentence as written for a command this build doesn't know", async () => {
    await i18n.changeLanguage('fr')
    const error = "Claude couldn't start. Run /rewind again."
    // A newer host's command, with a fact this build reads whole and a loaded row stating it.
    const result: AgentSessionConversationCommandResult = JSON.parse(
      `{ "command": "rewind", "state": "completed", "error": ${JSON.stringify(error)}, "failure": { "kind": "startFailed" } }`
    )
    expect(
      await sendStructuredConversationCommand({
        command: 'compact',
        agentName: 'Claude',
        pending: { current: false },
        hold: null,
        untilAheadHandedOver: async () => true,
        startFailures: () => [START_FAILED],
        send: async () => ({ kind: 'done', value: result })
      })
    ).toEqual({ accepted: false, error })
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

describe('a /compact the host holds in line', () => {
  it('reads its queued answer as sent, with no line under the composer', async () => {
    expect(
      await sent({
        command: 'compact',
        state: 'completed',
        queued: { messageId: 'op-1', position: 1, state: 'waiting' }
      })
    ).toEqual({ accepted: true, error: null })
  })

  const idle = {
    waitsInLine: false,
    turnActive: false,
    promptPending: false,
    backgroundTasksRunning: false,
    outboxHeld: false,
    outboxUnsent: false
  }

  it('is held here only by a message the host does not have yet, or background work', () => {
    const inLine = { ...idle, waitsInLine: true }
    expect(
      structuredConversationCommandHold({
        ...inLine,
        turnActive: true,
        promptPending: true,
        outboxHeld: true
      })
    ).toBeNull()
    expect(structuredConversationCommandHold({ ...inLine, outboxUnsent: true })).toBe('ahead')
    expect(structuredConversationCommandHold({ ...inLine, backgroundTasksRunning: true })).toBe(
      'background'
    )
  })

  it('against a host that cannot hold it, and for /clear, keeps every check', () => {
    expect(structuredConversationCommandHold(idle)).toBeNull()
    expect(structuredConversationCommandHold({ ...idle, turnActive: true })).toBe('working')
    expect(structuredConversationCommandHold({ ...idle, outboxHeld: true })).toBe('working')
    expect(structuredConversationCommandHold({ ...idle, promptPending: true })).toBe('prompt')
  })
})

describe('a command held here', () => {
  function held(
    command: 'clear' | 'compact',
    hold: Parameters<typeof sendStructuredConversationCommand>[0]['hold'],
    untilAheadHandedOver: () => Promise<boolean> = async () => true
  ) {
    const send = vi.fn(async () => ({
      kind: 'done' as const,
      value: { command, state: 'completed' as const }
    }))
    return {
      send,
      result: sendStructuredConversationCommand({
        command,
        agentName: structuredAgentLabel('claude'),
        pending: { current: false },
        hold,
        untilAheadHandedOver,
        startFailures: () => [],
        send
      })
    }
  }

  it('behind a message on its way waits for it with no line, then goes out', async () => {
    let handOver: (mounted: boolean) => void = () => {}
    const { send, result } = held(
      'compact',
      'ahead',
      () => new Promise<boolean>((resolve) => (handOver = resolve))
    )
    await Promise.resolve()
    expect(send).not.toHaveBeenCalled()
    handOver(true)
    expect(await result).toEqual({ accepted: true, error: null })
    expect(send).toHaveBeenCalledOnce()
  })

  it('sends nothing and says nothing when the pane goes away while it waits', async () => {
    const { send, result } = held('compact', 'ahead', async () => false)
    expect(await result).toEqual({ accepted: false, error: null })
    expect(send).not.toHaveBeenCalled()
  })

  it('a second press while one is on its way says nothing', async () => {
    const pending = { current: true }
    const send = vi.fn()
    expect(
      await sendStructuredConversationCommand({
        command: 'compact',
        agentName: structuredAgentLabel('claude'),
        pending,
        hold: null,
        untilAheadHandedOver: async () => true,
        startFailures: () => [],
        send
      })
    ).toEqual({ accepted: false, error: null })
    expect(send).not.toHaveBeenCalled()
  })

  it('a /clear while the agent works says so in plain words, once', async () => {
    expect(await held('clear', 'working').result).toEqual({
      accepted: false,
      error: "The agent is still working. Run /clear when it's done."
    })
    expect(await held('clear', 'prompt').result).toEqual({
      accepted: false,
      error: "Answer the agent's question or approval, then run /clear."
    })
  })

  it('a /compact a host without the queue refuses reads the same way', async () => {
    expect(await held('compact', 'working').result).toEqual({
      accepted: false,
      error: "The agent is still working. Run /compact when it's done."
    })
    expect(await held('compact', 'prompt').result).toEqual({
      accepted: false,
      error: "Answer the agent's question or approval, then run /compact."
    })
  })
})
