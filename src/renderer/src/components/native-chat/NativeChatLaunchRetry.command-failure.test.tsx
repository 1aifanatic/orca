// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { readAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import {
  agentSessionRefusalFailure,
  readAgentSessionErrorRefusal
} from '../../../../shared/agent-session-write-failure'
import { NativeChatLaunchRetry } from './NativeChatLaunchRetry'

afterEach(cleanup)

it.each(['customCommandInvalid', 'customCommandConflict'] as const)(
  'shows actionable Command setting feedback for %s',
  (reason) => {
    const failure = agentSessionRefusalFailure({
      code: 'agent_session_operation_invalid',
      details: { reason }
    })
    render(
      <NativeChatLaunchRetry
        lifecycle="failed"
        failure={failure}
        agentLabel="Claude"
        onRetry={() => {}}
      />
    )
    expect(screen.getByText(/Settings → Agents → Command/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  }
)

it('keeps the generic start failure on a client that cannot recognize the host reason', () => {
  const refusal = readAgentSessionErrorRefusal({
    response: {
      error: {
        data: {
          refusal: {
            code: 'agent_session_operation_invalid',
            details: { reason: 'commandReasonFromNewerHost' }
          }
        }
      }
    }
  })
  if (!refusal) {
    throw new Error('expected a parsed refusal')
  }
  const failure = agentSessionRefusalFailure(refusal)
  expect(failure).toEqual({ kind: 'refused', code: 'agent_session_operation_invalid' })
  render(
    <NativeChatLaunchRetry
      lifecycle="failed"
      failure={failure}
      agentLabel="Claude"
      onRetry={() => {}}
    />
  )
  expect(screen.getByText('Chat could not be started.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
})

it('keeps the generic start failure when the host failure kind is newer than the client', () => {
  const fact = readAgentSessionFailureFact({ kind: 'commandKindFromNewerHost' })
  expect(fact).toBeUndefined()
  render(<NativeChatLaunchRetry lifecycle="failed" agentLabel="Claude" onRetry={() => {}} />)
  expect(screen.getByText('Chat could not be started.')).toBeTruthy()
})
