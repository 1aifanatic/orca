import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  linuxOomKillDetails,
  readLinuxOomKillCounters,
  setLinuxOomKillFileReaderForTest
} from './linux-oom-kill-counters'
import {
  preGoneLinuxOomKillDetails,
  resetPreGoneSystemMemorySamplingForTest,
  samplePreGoneSystemMemory
} from './pre-gone-host-memory'
import { setSystemMemoryInfoReaderForTest } from './system-memory-details'
import { setSwapVolumeFreeSpaceReaderForTest } from './swap-volume-free-space'

// Paths and contents as read on Ubuntu 24.04 (WSL2 kernel 6.18) during the scan-35 repro.
const SCOPE = '/user.slice/user-1000.slice/user@1000.service/app.slice/orca.scope'

function fakeHost(state: { hostKills: number; cgroupKills: number; memoryMax?: string }) {
  return (path: string): string | undefined => {
    switch (path) {
      case '/proc/vmstat':
        return `pgfault 123\noom_kill ${state.hostKills}\npgmajfault 4\n`
      case '/proc/self/cgroup':
        return `0::${SCOPE}\n`
      case `/sys/fs/cgroup${SCOPE}/memory.events`:
        return `low 0\nhigh 0\nmax 12\noom 1\noom_kill ${state.cgroupKills}\noom_group_kill 0\n`
      case `/sys/fs/cgroup${SCOPE}/memory.max`:
        return 'max\n'
      case '/sys/fs/cgroup/user.slice/user-1000.slice/memory.max':
        return state.memoryMax ?? 'max\n'
      case '/proc/pressure/memory':
        return 'some avg10=42.50 avg60=10.00 avg300=2.00 total=1\nfull avg10=30.00 avg60=0 avg300=0 total=1\n'
      default:
        return undefined
    }
  }
}

afterEach(() => {
  setLinuxOomKillFileReaderForTest(null)
})

describe('readLinuxOomKillCounters', () => {
  it('returns null off Linux', () => {
    setLinuxOomKillFileReaderForTest(fakeHost({ hostKills: 1, cgroupKills: 1 }), 'darwin')
    expect(readLinuxOomKillCounters()).toBeNull()
  })

  it('reads host and cgroup counters, PSI, and the nearest ancestor memory limit', () => {
    setLinuxOomKillFileReaderForTest(
      fakeHost({ hostKills: 3, cgroupKills: 1, memoryMax: `${8 * 1024 * 1024 * 1024}\n` }),
      'linux'
    )
    expect(readLinuxOomKillCounters()).toEqual({
      vmstatOomKill: 3,
      cgroupOomKill: 1,
      cgroupMemoryMaxMB: 8192,
      memoryPressureSomeAvg10: 42.5
    })
  })

  it('degrades to the host counter on a cgroup v1-only host', () => {
    const host = fakeHost({ hostKills: 2, cgroupKills: 0 })
    setLinuxOomKillFileReaderForTest(
      (path) => (path === '/proc/self/cgroup' ? '4:memory:/user.slice\n' : host(path)),
      'linux'
    )
    expect(readLinuxOomKillCounters()).toEqual({ vmstatOomKill: 2, memoryPressureSomeAvg10: 42.5 })
  })
})

describe('linuxOomKillDetails', () => {
  it('names an Orca cgroup kill even when the host counter also moved', () => {
    expect(
      linuxOomKillDetails(
        { vmstatOomKill: 5, cgroupOomKill: 0, memoryPressureSomeAvg10: 61 },
        12_000,
        { vmstatOomKill: 6, cgroupOomKill: 1, cgroupMemoryMaxMB: 600 }
      )
    ).toEqual({
      linuxOomKillBaselineAgeMs: 12_000,
      linuxOomKillHostDelta: 1,
      linuxOomKillCgroupDelta: 1,
      linuxOomKillVerdict: 'orca-cgroup-oom-kill',
      linuxCgroupMemoryMaxMB: 600,
      linuxMemoryPressurePreGoneSomeAvg10: 61
    })
  })

  it('reports a host-only kill when Orca has no readable cgroup counter', () => {
    expect(linuxOomKillDetails({ vmstatOomKill: 0 }, 5_000, { vmstatOomKill: 1 })).toMatchObject({
      linuxOomKillHostDelta: 1,
      linuxOomKillVerdict: 'host-oom-kill'
    })
  })

  it('says no kernel OOM kill when neither counter moved (a userspace killer or kill -9)', () => {
    expect(
      linuxOomKillDetails({ vmstatOomKill: 7, cgroupOomKill: 2 }, 5_000, {
        vmstatOomKill: 7,
        cgroupOomKill: 2
      })
    ).toMatchObject({ linuxOomKillVerdict: 'no-kernel-oom-kill' })
  })

  it('emits nothing when no counter was readable on both sides', () => {
    expect(linuxOomKillDetails({}, 5_000, { vmstatOomKill: 1 })).toEqual({})
  })
})

describe('preGoneLinuxOomKillDetails', () => {
  beforeEach(() => {
    resetPreGoneSystemMemorySamplingForTest()
    setSystemMemoryInfoReaderForTest(() => ({ total: 16_000 * 1024, available: 4_000 * 1024 }))
    setSwapVolumeFreeSpaceReaderForTest(vi.fn(async () => undefined))
  })

  afterEach(() => {
    resetPreGoneSystemMemorySamplingForTest()
    setSystemMemoryInfoReaderForTest(null)
    setSwapVolumeFreeSpaceReaderForTest(null)
  })

  it('is empty before any baseline was sampled', () => {
    setLinuxOomKillFileReaderForTest(fakeHost({ hostKills: 0, cgroupKills: 0 }), 'linux')
    expect(preGoneLinuxOomKillDetails(1_000)).toEqual({})
  })

  it('compares against the older baseline so a tick between kill and gone event cannot hide it', async () => {
    const state = { hostKills: 0, cgroupKills: 0 }
    setLinuxOomKillFileReaderForTest(fakeHost(state), 'linux')
    await samplePreGoneSystemMemory(10_000)
    state.hostKills = 1
    state.cgroupKills = 1
    // The next tick lands after the kernel killed the renderer but before main saw it go.
    await samplePreGoneSystemMemory(20_000)
    expect(preGoneLinuxOomKillDetails(20_050)).toMatchObject({
      linuxOomKillBaselineAgeMs: 10_050,
      linuxOomKillCgroupDelta: 1,
      linuxOomKillVerdict: 'orca-cgroup-oom-kill'
    })
  })

  it('is empty off Linux', async () => {
    setLinuxOomKillFileReaderForTest(fakeHost({ hostKills: 0, cgroupKills: 0 }), 'win32')
    await samplePreGoneSystemMemory(10_000)
    expect(preGoneLinuxOomKillDetails(10_050)).toEqual({})
  })
})
