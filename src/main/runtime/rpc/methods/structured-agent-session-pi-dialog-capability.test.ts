import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { CLAUDE_STRUCTURED_AGENT } from '../../../claude/claude-structured-agent-definition'
import { PI_RPC_AGENT } from '../../../pi/rpc-agent-definition'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  call,
  clearStructuredHostStub,
  envelope,
  hostCalls,
  hostStub,
  installStructuredHostStub,
  runtimeCalls,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

const OLD_CLIENT = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: [
    ...STRUCTURED_CLIENT.clientCapabilities,
    STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  ]
}
const PI_CLIENT = {
  ...OLD_CLIENT,
  clientCapabilities: [...OLD_CLIENT.clientCapabilities, PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY]
}
const UNSUPPORTED = { message: expect.stringContaining('structured_agent_session_unsupported') }

beforeEach(installStructuredHostStub)
afterEach(clearStructuredHostStub)

describe('Pi dialog-shape client capability', () => {
  it('filters only Pi from the registered agent list of an older client', async () => {
    setStructuredAgentSessionHost(
      Object.assign(hostStub(), {
        agentDefinitions: () => [CLAUDE_STRUCTURED_AGENT, PI_RPC_AGENT]
      })
    )

    expect(await call('agentSession.agents', {}, OLD_CLIENT)).toMatchObject({
      ok: true,
      result: { agents: [{ agent: 'claude' }] }
    })
    expect(await call('agentSession.agents', {}, PI_CLIENT)).toMatchObject({
      ok: true,
      result: { agents: [{ agent: 'claude' }, { agent: 'pi' }] }
    })
  })

  it('refuses Pi create support before asking the runtime, while other agents keep their path', async () => {
    expect(
      await call(
        'agentSession.createSupport',
        { worktree: 'id:workspace-1', agent: 'pi' },
        OLD_CLIENT
      )
    ).toMatchObject({ ok: false, error: UNSUPPORTED })
    expect(runtimeCalls.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()

    expect(
      await call(
        'agentSession.createSupport',
        { worktree: 'id:workspace-1', agent: 'grok' },
        OLD_CLIENT
      )
    ).toMatchObject({ ok: true })
    expect(
      await call(
        'agentSession.createSupport',
        { worktree: 'id:workspace-1', agent: 'pi' },
        PI_CLIENT
      )
    ).toMatchObject({ ok: true })
  })

  it('refuses Pi create before resolution or attachment', async () => {
    const params = {
      envelope: envelope({
        expectedRuntimeFence: null,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.create',
          sessionId: SESSION,
          fields: { worktree: 'id:workspace-1', agent: 'pi' }
        })
      }),
      worktree: 'id:workspace-1',
      agent: 'pi'
    }
    expect(await call('agentSession.create', params, OLD_CLIENT)).toMatchObject({
      ok: false,
      error: UNSUPPORTED
    })
    expect(runtimeCalls.resolveStructuredAgentSessionCreateIntent).not.toHaveBeenCalled()
    expect(hostCalls.attach).not.toHaveBeenCalled()
    expect(await call('agentSession.create', params, PI_CLIENT)).toMatchObject({ ok: true })
  })

  it('withholds Pi journal history from a client that cannot show its dialogs', async () => {
    hostCalls.sessionAgent.mockReturnValue('pi')
    expect(
      await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, OLD_CLIENT)
    ).toMatchObject({ ok: false, error: UNSUPPORTED })
    expect(hostCalls.history).not.toHaveBeenCalled()
    expect(
      await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, PI_CLIENT)
    ).toMatchObject({ ok: true })
  })
})
