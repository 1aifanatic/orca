import { describe, expect, it } from 'vitest'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogFingerprint } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { withMissingProviderExecutable } from '../provider-process/provider-executable-missing'
import { recordCodexMissingCli } from './codex-structured-acquire-catalog'

const HOME = '/homes/codex-account'
const FINGERPRINT = agentModelCatalogFingerprint({
  agent: 'codex',
  accountHomeVariable: 'CODEX_HOME',
  accountHomePath: HOME,
  wslDistro: null
})

describe('a Codex start whose CLI the spawn never found', () => {
  it("is that home's verdict, as the catalog probe would type it", () => {
    const store = new AgentModelCatalogStore()
    recordCodexMissingCli(
      { modelCatalog: store },
      { codexHome: HOME },
      withMissingProviderExecutable(new Error('codex app-server connection ended'))
    )
    expect(store.unavailable(FINGERPRINT)).toMatchObject({ reason: 'cliMissing' })
  })

  it('records nothing for any other failed start', () => {
    const store = new AgentModelCatalogStore()
    recordCodexMissingCli(
      { modelCatalog: store },
      { codexHome: HOME },
      new Error('exited (code 1)')
    )
    expect(store.unavailable(FINGERPRINT)).toBeUndefined()
  })
})
