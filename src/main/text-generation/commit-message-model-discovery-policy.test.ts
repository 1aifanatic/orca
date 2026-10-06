import { afterEach, expect, it, vi } from 'vitest'
import { getAgentModelProbeSpec } from '../../shared/agent-model-probe-spec'
import { finalizeModelDiscoveryOutput } from './commit-message-model-discovery-policy'

afterEach(() => {
  vi.restoreAllMocks()
})

it("keeps a failed probe's control replies, which name the account, out of the log and error", () => {
  const spec = getAgentModelProbeSpec('claude')
  if (!spec) {
    throw new Error('Missing Claude probe spec')
  }
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const initialized = JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'orca-catalog-initialize',
      response: { account: { email: 'person@example.com', organization: 'Example Org' } }
    }
  })
  const result = finalizeModelDiscoveryOutput(
    spec,
    `${initialized}\nprovider said no\n`,
    'stderr words',
    1
  )
  const text = JSON.stringify([logged.mock.calls, result])
  expect(text).not.toContain('person@example.com')
  expect(text).not.toContain('Example Org')
  // The rest of the output still explains the failure.
  expect(text).toContain('provider said no')
  expect(text).toContain('stderr words')
  expect(result).toMatchObject({ success: false })
})
