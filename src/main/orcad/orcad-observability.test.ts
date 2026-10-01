import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { installOrcadObservability } from './orcad-observability'

const CI_ENV = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'JENKINS_URL',
  'TEAMCITY_VERSION'
]

describe('orcad trace file', () => {
  let dataRoot: string

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'orca-orcad-observability-'))
    setAppEnvironment({
      getPath: (name) => {
        if (name !== 'userData') {
          throw new Error(`unexpected getPath: ${name}`)
        }
        return dataRoot
      },
      getAppPath: () => dataRoot,
      getVersion: () => '0.0.0-test',
      isPackaged: () => true,
      onWillQuit: () => {},
      exit: () => {},
      getAppMetrics: () => []
    })
    // The lane is off in CI and when diagnostics are disabled; this asserts the default host.
    for (const name of [...CI_ENV, 'ORCA_DIAGNOSTICS_DISABLED']) {
      vi.stubEnv(name, '')
    }
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(dataRoot, { recursive: true, force: true })
  })

  it('writes a structured chat failure under the data root, flushed by quit', () => {
    const quitHandlers: (() => void)[] = []
    installOrcadObservability((handler) => quitHandlers.push(handler))

    createStructuredAgentSessionLogger().warn('settling a late dispatch failed', {
      scope: 'late-settlement',
      sessionId: 'session-1',
      error: new Error('disk full')
    })
    for (const handler of quitHandlers) {
      handler()
    }

    const records = readFileSync(join(dataRoot, 'logs', 'main.trace.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records).toContainEqual(
      expect.objectContaining({
        name: 'agentSession.late-settlement',
        attributes: expect.objectContaining({ sessionId: 'session-1' }),
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    )
  })
})

// Booting orcad here would need its whole runtime; the wiring is pinned the way the agent-status
// store's is, by the entry point's own text.
it('orcad installs the trace file before its runtime', () => {
  const entry = readFileSync(join(import.meta.dirname, 'orcad-entry.ts'), 'utf8')
  const install = entry.indexOf(
    'installOrcadObservability((handler) => getAppEnvironment().onWillQuit(handler))'
  )
  expect(install).toBeGreaterThan(-1)
  expect(install).toBeLessThan(entry.indexOf('new OrcaRuntimeService('))
})
