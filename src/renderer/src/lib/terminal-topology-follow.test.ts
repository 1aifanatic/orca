import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { TerminalTopologySlice } from '../../../shared/terminal-topology-slice'
import { followTerminalTopology } from './terminal-topology-follow'

const WT = 'repo::/wt'
const initial = useAppStore.getState()

function slice(publishSeq: number, tabIds: string[]): TerminalTopologySlice {
  return {
    hostId: 'local',
    worktreeId: WT,
    publishSeq,
    revision: 1,
    tabs: tabIds.map((id) => ({ id, ptyId: null, worktreeId: WT, createdAt: 1 })),
    layouts: {},
    sleeping: {}
  }
}

function fakeMain(pulled: () => TerminalTopologySlice[]) {
  const calls: string[] = []
  let listener: ((slice: TerminalTopologySlice) => void) | undefined
  let releasePull!: () => void
  const pullGate = new Promise<void>((resolve) => {
    releasePull = resolve
  })
  const unsubscribe = vi.fn()
  return {
    calls,
    unsubscribe,
    releasePull,
    push: (next: TerminalTopologySlice) => listener?.(next),
    source: {
      onTerminalTopologyChanged: (callback: (next: TerminalTopologySlice) => void) => {
        calls.push('subscribe')
        listener = callback
        return unsubscribe
      },
      getTerminalTopologySlices: async () => {
        calls.push('pull')
        await pullGate
        return pulled()
      }
    }
  }
}

const tabIds = () => (useAppStore.getState().tabsByWorktree[WT] ?? []).map((tab) => tab.id)
const apply = (next: TerminalTopologySlice) =>
  useAppStore.getState().applyTerminalTopologySlice(next)

afterEach(() => {
  useAppStore.setState(initial, true)
})

describe('followTerminalTopology', () => {
  it('subscribes before pulling and resolves only once the pull is applied', async () => {
    const main = fakeMain(() => [slice(2, ['a'])])
    let settled = false
    const following = followTerminalTopology(main.source, apply, new AbortController().signal).then(
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    expect(main.calls).toEqual(['subscribe', 'pull'])
    expect(settled).toBe(false)

    main.releasePull()
    await following
    expect(tabIds()).toEqual(['a'])
  })

  it('keeps a push that raced ahead of an older pull', async () => {
    const main = fakeMain(() => [slice(2, ['a'])])
    const following = followTerminalTopology(main.source, apply, new AbortController().signal)
    main.push(slice(3, ['a', 'b']))
    main.releasePull()
    await following
    expect(tabIds()).toEqual(['a', 'b'])
  })

  it('ignores a push delivered after a pull that already held a newer slice', async () => {
    const main = fakeMain(() => [slice(5, ['a', 'b'])])
    const following = followTerminalTopology(main.source, apply, new AbortController().signal)
    main.releasePull()
    await following
    main.push(slice(4, ['a']))
    expect(tabIds()).toEqual(['a', 'b'])
    main.push(slice(6, ['b']))
    expect(tabIds()).toEqual(['b'])
  })

  it('stops following when the boot is aborted', async () => {
    const main = fakeMain(() => [])
    const abort = new AbortController()
    const following = followTerminalTopology(main.source, apply, abort.signal)
    main.releasePull()
    await following
    abort.abort()
    expect(main.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('keeps following pushes when the startup pull fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const main = fakeMain(() => {
      throw new Error('ipc down')
    })
    const following = followTerminalTopology(main.source, apply, new AbortController().signal)
    main.releasePull()
    await following
    main.push(slice(1, ['a']))
    expect(tabIds()).toEqual(['a'])
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
