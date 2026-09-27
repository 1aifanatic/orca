import { describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import { watchAgentComposerReady } from './agent-composer-ready-watch'

const COMMAND_START = '\x1b]133;C\x07'
const COMMAND_DONE = '\x1b]133;D;0\x07'
const PROMPT_START = '\x1b]133;A\x07'
const BRACKETED_PASTE_ON = '\x1b[?2004h'
const SHOW_CURSOR = '\x1b[?25h'

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
  return { composer, emit: (data: string) => emit(data), unsubscribe }
}

describe('watchAgentComposerReady', () => {
  it('arms once the agent enables bracketed paste while its command owns the PTY', () => {
    const w = watch()
    w.emit(`${COMMAND_START}goose banner`)
    expect(w.composer.signal()).toBe('none')

    w.emit(BRACKETED_PASTE_ON)
    expect(w.composer.signal()).toBe('armed')
  })

  it("ignores the shell's own bracketed paste before any command starts", () => {
    const w = watch()
    w.emit(`${PROMPT_START}prompt> ${BRACKETED_PASTE_ON}`)
    expect(w.composer.signal()).toBe('none')
  })

  it('never arms on a shell that marks no commands at all', () => {
    // A shell without OSC 133 (fish, cmd, an unwrapped sh) gives no proof the agent owns the PTY.
    const w = watch()
    w.emit(`prompt> ${BRACKETED_PASTE_ON}`)
    expect(w.composer.signal()).toBe('none')
  })

  it('drops the evidence when the command ends and the shell re-arms paste for its prompt', () => {
    const w = watch()
    w.emit(`${COMMAND_START}${BRACKETED_PASTE_ON}`)
    w.emit(`${COMMAND_DONE}${PROMPT_START}prompt> ${BRACKETED_PASTE_ON}`)
    expect(w.composer.signal()).toBe('none')
  })

  it("starts over for the next command: the last one's bracketed paste proves nothing", () => {
    const w = watch()
    w.emit(`${COMMAND_START}${BRACKETED_PASTE_ON}${COMMAND_DONE}${COMMAND_START}booting`)
    expect(w.composer.signal()).toBe('none')
  })

  it('switches ownership on a mark split across chunks', () => {
    const w = watch()
    w.emit('prompt> \x1b]13')
    w.emit(`3;C\x07${BRACKETED_PASTE_ON}`)
    expect(w.composer.signal()).toBe('armed')
  })

  it("reports ready on the agent's own composer marker", () => {
    const w = watch('opencode')
    w.emit(`${COMMAND_START}${BRACKETED_PASTE_ON}`)
    // opencode's signal carries no quiet window; only its show-cursor after 2004 counts.
    expect(w.composer.signal()).toBe('none')

    w.emit(SHOW_CURSOR)
    expect(w.composer.signal()).toBe('ready')
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
