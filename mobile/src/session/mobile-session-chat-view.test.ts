import { describe, expect, it } from 'vitest'
import type { TerminalPaneLayoutNode } from '../../../src/shared/terminal-tab-types'
import {
  chatPairToggleTarget,
  chatViewIdentityFence,
  chatViewLeafIds,
  hostChatPairForRow,
  resolveMobileLeafView,
  type MobileChatViewInputs,
  type MobileChatViewRow
} from './mobile-session-chat-view'

const split: TerminalPaneLayoutNode = {
  type: 'split',
  direction: 'vertical',
  first: { type: 'leaf', leafId: 'A' },
  second: { type: 'leaf', leafId: 'B' }
}
const sole: TerminalPaneLayoutNode = { type: 'leaf', leafId: 'A' }

function row(overrides: Partial<MobileChatViewRow> = {}): MobileChatViewRow {
  return {
    type: 'terminal',
    id: 'P::A',
    parentTabId: 'P',
    leafId: 'A',
    parentLayout: { root: sole },
    ...overrides
  }
}

const chatDefault: MobileChatViewInputs = {
  defaultView: { value: 'chat', settled: true },
  readability: 'readable'
}

function view(
  target: MobileChatViewRow,
  inputs: MobileChatViewInputs = chatDefault,
  rows: MobileChatViewRow[] = [target]
) {
  return resolveMobileLeafView(
    target,
    hostChatPairForRow(target),
    chatViewLeafIds(target, rows),
    inputs
  )
}

describe('resolveMobileLeafView (A1c-1)', () => {
  it('shows an explicit chat on its owner and terminal on every sibling', () => {
    const layout = { root: split, chatLeafId: 'B' }
    expect(view(row({ viewMode: 'chat', parentLayout: layout }))).toBe('terminal')
    expect(view(row({ id: 'P::B', leafId: 'B', viewMode: 'chat', parentLayout: layout }))).toBe(
      'chat'
    )
  })

  it('shows an ownerless chat on the sole leaf, or on the active leaf of a split, without claiming it', () => {
    expect(view(row({ viewMode: 'chat' }))).toBe('chat')
    const activeB = { root: split, activeLeafId: 'B' }
    expect(view(row({ viewMode: 'chat', parentLayout: activeB }))).toBe('terminal')
    expect(view(row({ id: 'P::B', leafId: 'B', viewMode: 'chat', parentLayout: activeB }))).toBe(
      'chat'
    )
    // No active leaf named: no leaf can be shown as the owner.
    expect(view(row({ viewMode: 'chat', parentLayout: { root: split } }))).toBe('terminal')
  })

  it('treats an owner outside the tree as a closed chat pane: terminal, and no survivor claims it', () => {
    const survivor = row({
      viewMode: 'chat',
      launchAgent: 'claude',
      parentLayout: { root: sole, chatLeafId: 'gone' }
    })
    expect(view(survivor)).toBe('terminal')
  })

  it('keeps an explicit terminal even when this device defaults to chat', () => {
    expect(view(row({ viewMode: 'terminal', launchAgent: 'claude' }))).toBe('terminal')
  })

  it('opens an unswitched sole leaf launched as a supported agent in this device default', () => {
    expect(view(row({ launchAgent: 'claude' }))).toBe('chat')
    expect(
      view(row({ launchAgent: 'claude' }), {
        defaultView: { value: 'terminal', settled: true },
        readability: 'readable'
      })
    ).toBe('terminal')
  })

  it('keeps every other unswitched tab terminal', () => {
    // No launch hint: a Terminal-started agent stays terminal whatever its status says.
    expect(view(row())).toBe('terminal')
    expect(view(row({ launchAgent: 'not-an-agent' }))).toBe('terminal')
    expect(view(row({ launchAgent: 'claude', parentLayout: { root: split } }))).toBe('terminal')
  })

  it('waits on an unsettled default instead of guessing', () => {
    expect(
      view(row({ launchAgent: 'claude' }), {
        defaultView: { value: 'terminal', settled: false },
        readability: 'readable'
      })
    ).toBe('undecided')
  })

  it('gates transcript-gated agents on settled readability', () => {
    const grok = row({ launchAgent: 'grok' })
    const at = (readability: MobileChatViewInputs['readability']) =>
      view(grok, { defaultView: { value: 'chat', settled: true }, readability })
    expect(at('readable')).toBe('chat')
    expect(at('unknown')).toBe('undecided')
    expect(at('unreadable')).toBe('terminal')
    expect(at('failed')).toBe('terminal')
  })

  it('never reads live agent status', () => {
    const withStatus = { ...row(), agentStatus: { agentType: 'claude', state: 'working' } }
    expect(view(withStatus)).toBe('terminal')
  })

  it('falls back to sibling rows when the snapshot carries no layout', () => {
    const a = row({ parentLayout: undefined, launchAgent: 'claude' })
    const b = row({ id: 'P::B', leafId: 'B', parentLayout: undefined })
    expect(chatViewLeafIds(a, [a, b])).toEqual(['A', 'B'])
    expect(view(a, chatDefault, [a, b])).toBe('terminal')
    expect(view(a, chatDefault, [a])).toBe('chat')
  })
})

describe('chatPairToggleTarget', () => {
  it('claims the pressed leaf, and leaves chat from the chat leaf', () => {
    const a = row({ parentLayout: { root: split } })
    expect(chatPairToggleTarget(a, {}, ['A', 'B'], chatDefault)).toEqual({
      viewMode: 'chat',
      chatLeafId: 'A'
    })
    expect(
      chatPairToggleTarget(a, { viewMode: 'chat', chatLeafId: 'A' }, ['A', 'B'], chatDefault)
    ).toEqual({ viewMode: 'terminal' })
    // A sibling of the chat leaf moves ownership instead of leaving chat.
    expect(
      chatPairToggleTarget(a, { viewMode: 'chat', chatLeafId: 'B' }, ['A', 'B'], chatDefault)
    ).toEqual({ viewMode: 'chat', chatLeafId: 'A' })
  })
})

describe('chatViewIdentityFence', () => {
  it('prefers the incarnation and falls back to the PTY id', () => {
    expect(chatViewIdentityFence(row({ incarnationId: 'inc-1', ptyId: 'pty-1' }))).toBe('inc-1')
    expect(chatViewIdentityFence(row({ ptyId: 'pty-1' }))).toBe('pty-1')
    expect(chatViewIdentityFence(row())).toBe('')
  })
})
