import type { StructuredAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'

export const OPENCODE_SERVE_TRANSPORT = 'opencode-serve'

function definition(agent: 'opencode' | 'opencode2'): StructuredAgentDefinition {
  return {
    agent,
    handleTransport: OPENCODE_SERVE_TRANSPORT,
    accountHomeVariable: 'XDG_DATA_HOME',
    capabilities: {
      rewind: false,
      compact: true,
      threadGoal: false,
      contextUsage: true,
      imagePrompts: true,
      steering: agent === 'opencode2' ? 'inject' : 'queue',
      approvalEnforcement: 'provider'
    },
    restingOptions: {
      acceptsKey: (key) => key === 'model' || key === 'effort' || key === 'mode',
      fallbackModels: () => null,
      effortDefaultsToModel: false
    }
  }
}

export const OPENCODE_STRUCTURED_AGENT = definition('opencode')
export const OPENCODE2_STRUCTURED_AGENT = definition('opencode2')
