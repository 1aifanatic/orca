// "Dismiss all" from the desktop prompt, through the context the desktop renderer really dispatches
// with: a paired runtime client without the registered-agents capability. A dismissal must stay
// final for every offer that client was shown, and leave an agent it cannot show alone.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_RECOVERY_CAPSULE_FILE,
  AgentSessionRecoveryCapsule
} from '../../agent-session-recovery-capsule'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import { CLAUDE_STRUCTURED_AGENT } from '../../../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../../../codex/codex-structured-agent-definition'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentRegistry } from '../../../native-chat/agent-session-wire/structured-agent-registry'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { interruptedRestart } from '../../../native-chat/agent-session-wire/structured-agent-session-restart-interruption-test-harness'
import { HOST_TEST_NOW as NOW } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { call, clearStructuredHostStub } from './structured-agent-session-rpc.test-fixture'

afterEach(() => {
  clearStructuredHostStub()
  vi.restoreAllMocks()
})

// Exactly what `runtime:call` in src/main/ipc/runtime.ts dispatches the local renderer with.
const DESKTOP = {
  clientKind: 'runtime' as const,
  clientCapabilities: [...DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES]
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a registry reads only the methods a declaration needs; these declare none.
const NO_METHODS = {} as StructuredAgentSessionAdapter
const declaring = (definition: typeof CLAUDE_STRUCTURED_AGENT) => ({
  definition: {
    ...definition,
    capabilities: { ...definition.capabilities, compact: false, threadGoal: false, rewind: false }
  },
  adapter: NO_METHODS
})

/** This build's two agents plus one the desktop does not render yet. */
function withPilot(): StructuredAgentRegistry {
  return new StructuredAgentRegistry([
    declaring(CLAUDE_STRUCTURED_AGENT),
    declaring(CODEX_STRUCTURED_AGENT),
    declaring({ ...CODEX_STRUCTURED_AGENT, agent: 'grok', accountHomeVariable: 'GROK_HOME' })
  ])
}

async function storedFence(root: string) {
  const { dismissedAt, dismissedSessions } = JSON.parse(
    await readFile(join(root, AGENT_SESSION_RECOVERY_CAPSULE_FILE), 'utf8')
  )
  return {
    ...(dismissedAt ? { dismissedAt } : {}),
    ...(dismissedSessions ? { dismissedSessions } : {})
  }
}

async function dismissAllFromDesktop() {
  return call('agentSession.restartResumableDismiss', {}, DESKTOP)
}

it('fences a dismissed offer against a late teardown write when the desktop sees every agent', async () => {
  const { host, root, marker } = await interruptedRestart()
  setStructuredAgentSessionHost(host)
  const capsule = new AgentSessionRecoveryCapsule(root)

  expect(await dismissAllFromDesktop()).toMatchObject({ ok: true, result: { dismissed: 1 } })
  // A teardown writer that captured this chat before the dismissal publishes late.
  await capsule.record([marker!], NOW)

  expect(await capsule.list(NOW)).toEqual([])
  // The unscoped dismissal every caller took before agents beyond Claude and Codex: one fence for all.
  expect(await storedFence(root)).toEqual({ dismissedAt: NOW + 1 })
  expect(await call('agentSession.restartResumable', {}, DESKTOP)).toMatchObject({
    ok: true,
    result: { sessions: [] }
  })
})

it('keeps a scoped dismiss-all final for what the desktop was shown when the host runs an agent it cannot show', async () => {
  const { host, root, marker } = await interruptedRestart(
    undefined,
    undefined,
    undefined,
    withPilot()
  )
  setStructuredAgentSessionHost(host)
  const capsule = new AgentSessionRecoveryCapsule(root)
  // An offer whose chat this launch cannot read names no agent the desktop was shown.
  const unreadable = { ...marker!, sessionId: 'unreadable-session' }
  await capsule.record([unreadable], NOW)

  expect(await dismissAllFromDesktop()).toMatchObject({ ok: true, result: { dismissed: 1 } })
  await capsule.record([marker!], NOW)

  expect(await capsule.list(NOW)).toEqual([unreadable])
  expect(await storedFence(root)).toEqual({ dismissedSessions: { [marker!.sessionId]: NOW + 1 } })
})
