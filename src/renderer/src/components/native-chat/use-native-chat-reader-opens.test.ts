// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import { useNativeChatReaderOpens } from './use-native-chat-reader-opens'

function harness() {
  const spies = {
    holdDisclosurePosition: vi.fn(),
    abortNavigation: vi.fn(),
    setSectionOpen: vi.fn(),
    setRosterOpen: vi.fn()
  }
  const { result } = renderHook(() => {
    const [, setExpandedTurnIds] = useState<ReadonlySet<string>>(new Set())
    return useNativeChatReaderOpens({
      subagentDisclosure: {
        setSectionOpen: spies.setSectionOpen,
        setRosterOpen: spies.setRosterOpen
      },
      setExpandedTurnIds,
      follow: { holdDisclosurePosition: spies.holdDisclosurePosition },
      abortNavigation: spies.abortNavigation
    })
  })
  const reacted = (): number => spies.holdDisclosurePosition.mock.calls.length
  return { result, spies, reacted }
}

// Each way a reader opens a row reports it under its own identity and abandons a history jump still paging.
it.each([
  [
    'a disclosure',
    'run:1',
    (opens: ReturnType<typeof useNativeChatReaderOpens>) =>
      opens.disclosures.onToggle?.('run:1', true)
  ],
  [
    'a folded turn',
    'turn:turn-1',
    (opens: ReturnType<typeof useNativeChatReaderOpens>) => opens.toggleExpandedTurn('turn-1')
  ],
  [
    'a subagent section',
    'section:a',
    (opens: ReturnType<typeof useNativeChatReaderOpens>) =>
      opens.subagentDisclosure.setSectionOpen('a', true)
  ],
  [
    'a subagent roster',
    'roster:r',
    (opens: ReturnType<typeof useNativeChatReaderOpens>) =>
      opens.subagentDisclosure.setRosterOpen('r', true)
  ]
])('reacts to the reader opening %s', (_kind, _row, open) => {
  const { result, spies } = harness()
  act(() => open(result.current))
  expect(spies.holdDisclosurePosition).toHaveBeenCalledOnce()
  expect(spies.abortNavigation).toHaveBeenCalledOnce()
})

it('bounds both opening and closing layout transactions', () => {
  const { result, spies, reacted } = harness()
  act(() => result.current.toggleExpandedTurn('turn-1'))
  expect(reacted()).toBe(1)

  act(() => result.current.toggleExpandedTurn('turn-1'))
  act(() => result.current.subagentDisclosure.setSectionOpen('a', false))
  act(() => result.current.subagentDisclosure.setRosterOpen('r', false))

  act(() => result.current.disclosures.onToggle?.('run:1', false))

  expect(reacted()).toBe(5)
  expect(spies.abortNavigation).toHaveBeenCalledTimes(5)
  expect(spies.setSectionOpen).toHaveBeenCalledWith('a', false)
  expect(spies.setRosterOpen).toHaveBeenCalledWith('r', false)
})
