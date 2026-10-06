// The program a host resolves for each agent reaches both consumers: the session launch and the
// session-less model-catalog probe. One resolver for both is what keeps a probe from listing a
// different binary's models than the session it stands in for.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexLaunch from '../codex/codex-structured-launch-resolution'
import type * as ClaudeLaunch from '../claude/claude-structured-launch-resolution'
import type * as CodexProbe from '../codex/codex-model-catalog-probe'
import type * as ClaudeProbe from '../claude/claude-model-catalog-probe'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const seen = vi.hoisted(() => ({
  codexLaunch: new Array<unknown>(),
  claudeLaunch: new Array<unknown>(),
  codexProbe: new Array<unknown>(),
  claudeProbe: new Array<unknown>()
}))

function resolveCommandOf(deps: unknown): unknown {
  return deps && typeof deps === 'object' && 'resolveCommand' in deps
    ? deps.resolveCommand
    : undefined
}

vi.mock('../codex/codex-structured-launch-resolution', async (importOriginal) => {
  const actual = await importOriginal<typeof CodexLaunch>()
  return {
    ...actual,
    createCodexStructuredLaunchResolver: (deps: CodexLaunch.CodexStructuredLaunchResolverDeps) => {
      seen.codexLaunch.push(resolveCommandOf(deps))
      return actual.createCodexStructuredLaunchResolver(deps)
    }
  }
})

vi.mock('../claude/claude-structured-launch-resolution', async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudeLaunch>()
  return {
    ...actual,
    createClaudeStructuredLaunchResolver: (
      deps: ClaudeLaunch.ClaudeStructuredLaunchResolverDeps
    ) => {
      seen.claudeLaunch.push(resolveCommandOf(deps))
      return actual.createClaudeStructuredLaunchResolver(deps)
    }
  }
})

vi.mock('../codex/codex-model-catalog-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof CodexProbe>()
  return {
    ...actual,
    createCodexModelCatalogProbe: (deps: CodexProbe.CodexModelCatalogProbeDeps) => {
      seen.codexProbe.push(resolveCommandOf(deps))
      return actual.createCodexModelCatalogProbe(deps)
    }
  }
})

vi.mock('../claude/claude-model-catalog-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudeProbe>()
  return {
    ...actual,
    createClaudeModelCatalogProbe: (deps: ClaudeProbe.ClaudeModelCatalogProbeDeps) => {
      seen.claudeProbe.push(resolveCommandOf(deps))
      return actual.createClaudeModelCatalogProbe(deps)
    }
  }
})

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-structured-program-threading-'))
  seen.codexLaunch.length = 0
  seen.claudeLaunch.length = 0
  seen.codexProbe.length = 0
  seen.claudeProbe.length = 0
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

describe('the resolved agent program', () => {
  it('reaches the session launch and the catalog probe for both agents', async () => {
    const resolveCodexCommand = (): string => '/configured/codex-wrapper'
    const resolveClaudeCommand = (): string => '/configured/claude-wrapper'
    await ensureStructuredAgentSessionHost({
      logger: createStructuredAgentSessionLogger(),
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root,
      resolveEnvironment: async () => ({}),
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
      resolveAgentAccountHome: async () => ({ variable: 'CODEX_HOME', path: root }),
      resolveCodexCommand,
      resolveClaudeCommand
    })

    expect(seen.codexLaunch).toEqual([resolveCodexCommand])
    expect(seen.codexProbe).toEqual([resolveCodexCommand])
    expect(seen.claudeLaunch).toEqual([resolveClaudeCommand])
    expect(seen.claudeProbe).toEqual([resolveClaudeCommand])
  })
})
