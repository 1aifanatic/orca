import { describe, expect, it } from 'vitest'
import { withPlatform } from '../window/createMainWindow-test-harness'
import {
  createLowCommitOomRecoveryGate,
  LOW_COMMIT_REPEAT_OOM_WINDOW_MS
} from './low-commit-oom-recovery-gate'

const OOM: Electron.RenderProcessGoneDetails = { reason: 'oom', exitCode: -536870904 }
const CRASHED: Electron.RenderProcessGoneDetails = { reason: 'crashed', exitCode: 5 }
// Launch 22912 (Scan-30 1790622432/1790622459): OOM at 19:06:54.6, reload OOMed again at 19:07:28.7.
const FIRST_OOM = Date.parse('2026-09-28T19:06:54.600Z')
const RELOAD_OOM = Date.parse('2026-09-28T19:07:28.700Z')

function sample(swapFreeMB: number | undefined, ageMs = 4_000) {
  return () => ({
    systemMemoryPreGoneSampleAgeMs: ageMs,
    ...(swapFreeMB === undefined ? {} : { systemMemoryPreGoneSwapFreeMB: swapFreeMB })
  })
}

function observeTwice(
  read: ReturnType<typeof sample>,
  second = OOM,
  gapMs = RELOAD_OOM - FIRST_OOM,
  platform: NodeJS.Platform = 'win32'
) {
  return withPlatform(platform, () => {
    const gate = createLowCommitOomRecoveryGate(read)
    const first = gate.assess(OOM, FIRST_OOM)
    gate.recordRecoveredDeath(OOM, FIRST_OOM)
    return [first, gate.assess(second, FIRST_OOM + gapMs)]
  })
}

describe('createLowCommitOomRecoveryGate', () => {
  it('holds the reload of a repeat OOM with 60 MB of commit left', () => {
    expect(observeTwice(sample(60))).toEqual([
      null,
      { availableCommitMB: 60, sincePreviousOomMs: 34_100 }
    ])
  })

  it('always lets the first OOM of the launch auto-reload, even with 5 MB left', () => {
    expect(observeTwice(sample(5))[0]).toBeNull()
  })

  it.each([
    ['commit is healthy (744 MB)', sample(744), OOM, 34_100, 'win32'],
    [
      'the previous OOM was over 5 minutes ago',
      sample(60),
      OOM,
      LOW_COMMIT_REPEAT_OOM_WINDOW_MS + 1,
      'win32'
    ],
    ['the death is not an OOM', sample(60), CRASHED, 34_100, 'win32'],
    ['no commit reading exists', sample(undefined), OOM, 34_100, 'win32'],
    ['the reading is stale', sample(60, 31_000), OOM, 34_100, 'win32'],
    ['the host is macOS', sample(60), OOM, 34_100, 'darwin'],
    ['the host is Linux', sample(60), OOM, 34_100, 'linux']
  ] as const)('reloads when %s', (_label, read, second, gapMs, platform) => {
    expect(observeTwice(read, second, gapMs, platform)[1]).toBeNull()
  })

  // Launch 13084 (Scan-31): 12:20:37.207 then 12:22:59.975; each OOM restarts the window.
  it('measures the window from the most recent OOM', () => {
    const verdicts = withPlatform('win32', () => {
      const gate = createLowCommitOomRecoveryGate(sample(60, 2_000))
      return [
        '2026-09-29T12:06:19.869Z',
        '2026-09-29T12:20:37.207Z',
        '2026-09-29T12:20:40.665Z',
        '2026-09-29T12:22:59.975Z'
      ].map((iso) => {
        const verdict = gate.assess(OOM, Date.parse(iso))
        gate.recordRecoveredDeath(OOM, Date.parse(iso))
        return verdict
      })
    })
    expect(verdicts.map((v) => v?.sincePreviousOomMs ?? null)).toEqual([null, null, 3_458, 139_310])
  })

  // Launch 13084: the repeat OOM came 3.458 s after the previous one, inside one 10 s sampler tick.
  it('ignores a reading taken before the previous OOM released its commit', () => {
    const gapMs = 3_458
    expect(observeTwice(sample(60, 5_000), OOM, gapMs)[1]).toBeNull()
    expect(observeTwice(sample(60, gapMs), OOM, gapMs)[1]).toBeNull()
    expect(observeTwice(sample(60, 1_000), OOM, gapMs)[1]).toEqual({
      availableCommitMB: 60,
      sincePreviousOomMs: gapMs
    })
  })

  it('does not start the repeat window for an OOM that was never recovered', () => {
    const verdict = withPlatform('win32', () => {
      const gate = createLowCommitOomRecoveryGate(sample(60, 2_000))
      gate.assess(OOM, FIRST_OOM)
      return gate.assess(OOM, RELOAD_OOM)
    })
    expect(verdict).toBeNull()
  })
})
