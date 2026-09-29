// Cross-version coverage for the agent-status payload: current code against the newest release.
//
// The hook server persists every row's payload to its status file, and after an update or a
// downgrade the other build re-admits it with its own `normalizeAgentStatusPayload`
// (server-persistence-validation.ts). A payload that normalizer refuses loses the row on
// restart; a field it reads differently is a row misread. That is the boundary this suite pairs.
// The canonical status store never leaves the process that owns it, and the relay that forwards
// hook envelopes is always the desktop's own build. Session-tab sync also carries each tab's
// status to paired clients of any version; it is not paired here.

import { beforeAll, describe, expect, it } from 'vitest'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

// Why: a cold CI run extracts the baseline checkout before the first pairing.
const SUITE_TIMEOUT_MS = 180_000

type Payload = Record<string, unknown>

type StatusBuild = {
  label: string
  states: readonly string[]
  normalize: (payload: unknown) => Payload | null
}

function toBuild(label: string, module: Record<string, unknown>): StatusBuild {
  const { AGENT_STATUS_STATES: states, normalizeAgentStatusPayload: normalize } = module
  if (typeof normalize !== 'function') {
    throw new Error(`Build ${label} exports no normalizeAgentStatusPayload`)
  }
  if (!Array.isArray(states) || !states.every((state) => typeof state === 'string')) {
    throw new Error(`Build ${label} exports no AGENT_STATUS_STATES arm set`)
  }
  return {
    label,
    states,
    normalize: (payload) => {
      const result: unknown = normalize(payload)
      return typeof result === 'object' && result !== null
        ? Object.fromEntries(Object.entries(result))
        : null
    }
  }
}

let current: StatusBuild
let baseline: StatusBuild

beforeAll(async () => {
  const baselineRef = resolveBaselineReleaseRef()
  const [working, released] = await Promise.all([
    import('../../../src/shared/agent-status-types'),
    materializeReleaseCheckout(baselineRef).then((checkout) =>
      importReleaseCheckoutModule(checkout, '/src/shared/agent-status-types.ts')
    )
  ])
  current = toBuild('working-tree', working)
  baseline = toBuild(baselineRef, released)
}, SUITE_TIMEOUT_MS)

/** Every optional field a row can carry; each build keeps what it knows for the given state. */
function rowFor(state: string): Payload {
  return {
    state,
    workingMode: 'monitoring',
    prompt: 'cross-version prompt',
    agentType: 'claude',
    model: 'claude-opus',
    modelSwitchCommand: 'orca-model',
    toolName: 'Read',
    toolInput: 'src/index.ts',
    interactivePrompt: 'Allow Read?',
    lastAssistantMessage: 'first line\nsecond line',
    lastAssistantMessageIsToolOutput: true,
    interrupted: true,
    sessionBoundary: true,
    turnCompletedAt: 1_700_000_000_500,
    subagents: [
      {
        id: 'subagent-1',
        agentType: 'explore',
        model: 'claude-haiku',
        description: 'scan the tree',
        state: 'working',
        startedAt: 1_700_000_000_000
      }
    ],
    mainAgent: { state, outcome: 'cancellation', stateStartedAt: 1_700_000_000_100 }
  }
}

function definedKeys(payload: Payload | null): string[] {
  return Object.keys(payload ?? {})
    .filter((key) => payload?.[key] !== undefined)
    .sort()
}

function describePairing(
  name: string,
  pair: () => { writer: StatusBuild; reader: StatusBuild }
): void {
  describe(name, () => {
    it('re-admits every row the writer persisted and reads each shared field as its own', () => {
      const { writer, reader } = pair()
      // Every arm the release can write; an arm current drops fails the old-writer direction.
      for (const state of baseline.states) {
        const raw = rowFor(state)
        const persisted = writer.normalize(raw)
        expect(persisted, `${writer.label} refused its own ${state} row`).not.toBeNull()
        const read = reader.normalize(JSON.parse(JSON.stringify(persisted)))
        expect(
          read,
          `${reader.label} dropped a ${state} row ${writer.label} persisted`
        ).not.toBeNull()
        // The reader's own normalization of the same row is the expectation, so a field only
        // one build knows is neither required nor refused.
        const own = reader.normalize(raw)
        const shared = definedKeys(persisted).filter((key) => definedKeys(own).includes(key))
        expect(
          Object.fromEntries(shared.map((key) => [key, read?.[key]])),
          `${reader.label} misread a ${state} row ${writer.label} persisted`
        ).toEqual(Object.fromEntries(shared.map((key) => [key, own?.[key]])))
      }
    })
  })
}

describePairing('new writer against old reader', () => ({ writer: current, reader: baseline }))
describePairing('old writer against new reader', () => ({ writer: baseline, reader: current }))

describe('what current code still writes', () => {
  it('keeps every status arm the baseline can write', () => {
    expect(baseline.states.length).toBeGreaterThan(0)
    expect(current.states).toEqual(expect.arrayContaining([...baseline.states]))
  })

  it('keeps every payload field the baseline writes', () => {
    // A field current stops writing reaches an older reader as `undefined` after a downgrade.
    for (const state of baseline.states) {
      const raw = rowFor(state)
      expect(definedKeys(current.normalize(raw)), state).toEqual(
        expect.arrayContaining(definedKeys(baseline.normalize(raw)))
      )
    }
  })
})
