import { describe, expect, it, vi } from 'vitest'
import {
  createDraftPasteReadyScanner,
  draftPasteReadySignalHasMarker
} from '../../shared/draft-paste-ready-scanner'
import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { watchAgentComposerReady } from './agent-composer-ready-watch'

const COMMAND_START = '\x1b]133;C\x07'
const COMMAND_DONE = '\x1b]133;D;0\x07'
const PROMPT_START = '\x1b]133;A\x07'
const BRACKETED_PASTE_ON = '\x1b[?2004h'
const SHOW_CURSOR = '\x1b[?25h'
const DECSET_ALT_SCREEN = '\x1b[?1049h'

function watch(agent: TuiAgent = 'goose', replay?: string) {
  let emit: (data: string) => void = () => {}
  const unsubscribe = vi.fn()
  const composer = watchAgentComposerReady(agent, {
    subscribeToData: (listener) => {
      emit = listener
      return unsubscribe
    },
    readRecentOutput: () => replay
  })
  if (!composer) {
    throw new Error(`no composer watch for ${agent}`)
  }
  return { composer, emit: (data: string) => emit(data), unsubscribe }
}

describe('launchReadiness declarations', () => {
  it('are held by exactly the agents whose captured composer a transcript test replays', () => {
    // Adding one means recording its first run: aider's manual-mode `.gitignore` question arms
    // bracketed paste just like its composer.
    const declared = Object.entries(TUI_AGENT_CONFIG)
      .filter(([, config]) => config.launchReadiness)
      .map(([agent, config]) => [agent, config.launchReadiness])
    expect(declared).toEqual([
      ['codex', 'composer-marker'],
      ['opencode', 'composer-marker'],
      ['goose', 'composer-quiet']
    ])
  })

  it('give every composer-marker agent a draft signal with a marker and no quiet window', () => {
    for (const config of Object.values(TUI_AGENT_CONFIG)) {
      const signal = config.draftPasteReadySignal
      if (config.launchReadiness === 'composer-marker') {
        expect(signal !== undefined && draftPasteReadySignalHasMarker(signal)).toBe(true)
        // Paste mode alone must never read as its composer.
        const scan = createDraftPasteReadyScanner(signal ?? 'codex-composer-prompt')
        expect(scan.observe(`${BRACKETED_PASTE_ON}${DECSET_ALT_SCREEN}`).armQuietTimer).toBe(false)
      }
    }
  })
})

describe('watchAgentComposerReady', () => {
  it.each(['aider', 'claude', 'claude-agent-teams', 'grok', 'opencode2'] as const)(
    'does not watch %s, which declares no launch readiness',
    (agent) => {
      const composer = watchAgentComposerReady(agent, {
        subscribeToData: () => () => {},
        readRecentOutput: () => undefined
      })
      expect(composer).toBeNull()
    }
  )

  it('arms once the agent enables bracketed paste while its command owns the PTY', () => {
    const w = watch()
    expect(w.composer.signal()).toBe('unowned')
    w.emit(`${COMMAND_START}goose banner`)
    expect(w.composer.signal()).toBe('pending')

    w.emit(BRACKETED_PASTE_ON)
    expect(w.composer.signal()).toBe('armed')
  })

  it("ignores the shell's own bracketed paste before any command starts", () => {
    const w = watch()
    w.emit(`${PROMPT_START}prompt> ${BRACKETED_PASTE_ON}`)
    expect(w.composer.signal()).toBe('unowned')
  })

  it('stays unowned on a shell that marks no commands at all', () => {
    // A shell without OSC 133 (fish, cmd, an unwrapped sh) gives no proof the agent owns the PTY.
    const w = watch()
    w.emit(`prompt> ${BRACKETED_PASTE_ON}`)
    expect(w.composer.signal()).toBe('unowned')
  })

  it('drops the evidence when the command ends and the shell re-arms paste for its prompt', () => {
    const w = watch()
    w.emit(`${COMMAND_START}${BRACKETED_PASTE_ON}`)
    w.emit(`${COMMAND_DONE}${PROMPT_START}prompt> ${BRACKETED_PASTE_ON}`)
    expect(w.composer.signal()).toBe('unowned')
  })

  it("starts over for the next command: the last one's bracketed paste proves nothing", () => {
    const w = watch()
    w.emit(`${COMMAND_START}${BRACKETED_PASTE_ON}${COMMAND_DONE}${COMMAND_START}booting`)
    expect(w.composer.signal()).toBe('pending')
  })

  it('switches ownership on a mark split across chunks', () => {
    const w = watch()
    w.emit('prompt> \x1b]13')
    w.emit(`3;C\x07${BRACKETED_PASTE_ON}`)
    expect(w.composer.signal()).toBe('armed')
  })

  it("reports ready on a composer-marker agent's own marker, never on paste mode alone", () => {
    const w = watch('opencode')
    w.emit(`${COMMAND_START}${BRACKETED_PASTE_ON}`)
    expect(w.composer.signal()).toBe('pending')

    w.emit(SHOW_CURSOR)
    expect(w.composer.signal()).toBe('ready')
  })

  it('stops reading the marker once the command ends', () => {
    const w = watch('opencode')
    w.emit(`${COMMAND_START}${BRACKETED_PASTE_ON}`)
    w.emit(`${COMMAND_DONE}${PROMPT_START}`)
    expect(w.composer.signal()).toBe('unowned')
  })

  it('reads output that arrived before the wait subscribed', () => {
    const w = watch(
      'goose',
      `${PROMPT_START}${BRACKETED_PASTE_ON}${COMMAND_START}${BRACKETED_PASTE_ON}`
    )
    expect(w.composer.signal()).toBe('armed')
  })

  it('unsubscribes on dispose', () => {
    const w = watch()
    w.composer.dispose()
    expect(w.unsubscribe).toHaveBeenCalled()
  })
})
