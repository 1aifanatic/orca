import { describe, expect, it } from 'vitest'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from './structured-agent-runtime-registrations'
import { registeredModelCatalogDiscovery } from './structured-agent-model-catalog-wiring'
import { acpModelCatalogDiscovery } from './structured-agent-model-catalog-discovery'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import type { StructuredAgentModelCatalogContext } from './structured-agent-runtime-registrations'

function context(): StructuredAgentModelCatalogContext {
  const unused = async (): Promise<never> => {
    throw new Error('building a probe resolves nothing')
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: building a probe only captures resolvers; none of these deps is read until a probe runs.
    deps: { stateDirectory: '/state' } as StructuredAgentModelCatalogContext['deps'],
    environment: {
      resolveBaseEnvironment: unused,
      resolveCodexEnvironment: unused,
      resolveClaudeInheritedEnv: unused
    }
  }
}

describe('the model catalog contract on every registration', () => {
  it.each(
    STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(
      (registration) => [registration.definition.agent, registration] as const
    )
  )('%s declares how its models are listed without a session', (_agent, registration) => {
    const discovery = registration.modelCatalog(context())
    expect(['probe', 'unavailable']).toContain(discovery.kind)
    if (discovery.kind === 'probe') {
      expect(discovery.probe).toBeTypeOf('function')
    } else {
      expect(discovery.reason).not.toBe('')
    }
  })

  it('gives the catalog service a probe for exactly the registrations that have one', () => {
    const { probes } = registeredModelCatalogDiscovery(
      STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
      context()
    )
    const listing = STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.filter(
      (registration) => registration.modelCatalog(context()).kind === 'probe'
    ).map((registration) => registration.definition.agent)
    expect(Object.keys(probes).sort()).toEqual([...listing].sort())
    // Every agent registered today lists its models without a session.
    expect(listing.sort()).toEqual(
      STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(
        (registration) => registration.definition.agent
      ).sort()
    )
  })

  it('says per registration whether a listing names the model a new chat runs', () => {
    const { listingNamesConfiguredModel } = registeredModelCatalogDiscovery(
      STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
      context()
    )
    // Codex's `model/list` and Grok's session-free `currentModelId` name it; the rest may be overridden.
    expect([...listingNamesConfiguredModel].sort()).toEqual(['codex', 'grok'])
  })

  it('maps an ACP agent with no session-free listing to an unavailable registration', () => {
    const spec = acpLaunchSpecFor('grok')!
    const discovery = acpModelCatalogDiscovery(
      { ...spec, modelDiscovery: { kind: 'unavailable', reason: 'no listing without a session' } },
      context()
    )
    expect(discovery).toEqual({ kind: 'unavailable', reason: 'no listing without a session' })
  })
})
