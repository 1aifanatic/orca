// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'

import { renderStatus } from './native-chat-notice-row.test-fixture'

afterEach(cleanup)

describe('Codex maintenance in notice rows', () => {
  it.each([null, '0.135.0'])(
    'offers the shared host action on a resumed Codex failure: %s',
    (installedVersion) => {
      const onClick = vi.fn()
      const label = installedVersion ? 'Update Codex' : 'Install Codex'
      const failure: AgentSessionFailureFact = {
        kind: 'startFailed',
        refusal: {
          code: 'agent_session_operation_invalid',
          details: {
            reason: 'attachFailed',
            codexInstallation: { installedVersion, minimumVersion: '0.136.0' }
          }
        }
      }
      renderStatus(
        {
          kind: 'status',
          tone: 'error',
          ...agentSessionFailureWords(failure, { agentName: 'Codex', surface: 'row' })
        },
        null,
        false,
        'Codex',
        {
          key: 'codex',
          kind: 'error',
          text: installedVersion
            ? 'Codex 0.135.0 is too old for chats. Update to 0.136.0 or newer.'
            : "Codex isn't installed.",
          action: { label, onClick }
        }
      )
      expect(onClick).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(onClick).toHaveBeenCalledOnce()
    }
  )
})
