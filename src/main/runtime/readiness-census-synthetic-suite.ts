// The synthetic census suite, split across files so no worker carries all 43 agents.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { checkCensusCases } from './readiness-census-baseline'
import { runSyntheticCase, syntheticCases } from './readiness-census-synthetic-matrix'

export const CENSUS_AGENTS: readonly TuiAgent[] = Object.keys(TUI_AGENT_CONFIG)
  .filter(isTuiAgent)
  .toSorted()

const AGENT_TIMEOUT_MS = 60_000

export function describeSyntheticCensus(agents: readonly TuiAgent[]): void {
  describe('readiness census: synthetic evidence matrix', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    beforeAll(() => {
      // Why darwin: verdicts must not depend on the CI host.
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      // Why only these: xterm's write queue runs on real setTimeout.
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    })
    afterAll(() => {
      vi.useRealTimers()
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    })

    it.each(agents)(
      '%s',
      async (agent) => {
        const observations: Record<string, string> = {}
        for (const entry of syntheticCases(agent)) {
          Object.assign(observations, await runSyntheticCase(agent, entry))
        }
        const diff = checkCensusCases(
          `synthetic/${agent}`,
          `${agent}: title x first-party status on a painted screen, then screen x foreground under the titles that leave the low lanes open; each read clocked and clockless`,
          observations
        )
        expect(diff).toBe('')
      },
      AGENT_TIMEOUT_MS
    )
  })
}
