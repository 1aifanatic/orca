// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { agentSessionRefusalFailure } from '../../../../shared/agent-session-write-failure'
import { NativeChatLaunchRetry } from './NativeChatLaunchRetry'

afterEach(cleanup)

it('names the Command setting when it is not a program Orca can run', () => {
  const failure = agentSessionRefusalFailure({
    code: 'agent_session_operation_invalid',
    details: { reason: 'agentCommandNotRunnable' }
  })
  render(
    <NativeChatLaunchRetry
      lifecycle="failed"
      failure={failure}
      agentLabel="Claude"
      onRetry={() => {}}
    />
  )
  expect(
    screen.getByText(
      "Chat could not be started. The Command set for Claude in Settings → Agents isn't a program Orca can run. Set it to a program path or name, or clear it."
    )
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
})
