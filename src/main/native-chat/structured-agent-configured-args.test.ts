import { describe, expect, it } from 'vitest'
import { structuredAgentConfiguredArgs } from './structured-agent-configured-args'
import {
  StructuredAgentArgumentsError,
  argumentProblemOf
} from './structured-agent-arguments-error'

function captured(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

describe('structured chat configured Arguments', () => {
  it.each(['claude', 'codex'] as const)(
    'reads the existing %s setting and preserves quoted values',
    (agent) => {
      expect(
        structuredAgentConfiguredArgs(
          agent,
          {
            agentDefaultArgs: { [agent]: '--model "model with spaces"' }
          },
          'darwin'
        )
      ).toEqual(['--model', 'model with spaces'])
      expect(structuredAgentConfiguredArgs(agent, { agentDefaultArgs: { [agent]: '' } })).toEqual(
        []
      )
    }
  )

  it('uses the existing default when the Arguments key is absent', () => {
    expect(structuredAgentConfiguredArgs('claude', {})).toEqual(['--dangerously-skip-permissions'])
  })

  it('preserves Windows paths under the configured shell', () => {
    expect(
      structuredAgentConfiguredArgs(
        'claude',
        {
          agentDefaultArgs: { claude: String.raw`--plugin-dir "C:\My Plugins"` },
          terminalWindowsShell: 'powershell'
        },
        'win32'
      )
    ).toEqual(['--plugin-dir', String.raw`C:\My Plugins`])
  })

  it.each([
    ['claude', 'Claude'],
    ['codex', 'Codex']
  ] as const)('refuses unclosed %s quotes as a saved Arguments problem', (agent, agentName) => {
    const read = () =>
      structuredAgentConfiguredArgs(agent, {
        agentDefaultArgs: { [agent]: '--model "unfinished secret' }
      })
    expect(read).toThrow(StructuredAgentArgumentsError)
    expect(argumentProblemOf(captured(read))).toEqual({
      agent: agentName,
      option: 'quote',
      problem: 'unclosedQuote'
    })
  })
})
