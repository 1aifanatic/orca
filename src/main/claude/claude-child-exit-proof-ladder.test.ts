import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
import {
  createClaudeChildTreeReaper,
  type ClaudeChildTreeReaper
} from './claude-agent-sdk-exit-proof'
import { proveClaudeChildExitWithReaper } from './claude-child-exit-proof-ladder'

function fakeTree(): ClaudeChildTreeReaper & { reap: ReturnType<typeof vi.fn> } {
  return {
    capture: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    reap: vi.fn(async () => 'exited' as const),
    treeVerdict: 'exited',
    forcedReapAttempted: false
  }
}

/** A root that leaves only once a SIGTERM has had `stopMs` to act, the way a supervisor does. */
function rootStoppedBySigterm(stopMs: number) {
  let exited = false
  let settle = (): void => {}
  const exitPromise = new Promise<void>((resolve) => {
    settle = resolve
  })
  const kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (signal === 'SIGTERM') {
      setTimeout(() => {
        exited = true
        settle()
      }, stopMs)
    }
    return true
  })
  const stdin = { end: vi.fn() }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The ladder reads only pid, kill and stdin.end from its child.
    child: { pid: 4321, kill, stdin } as unknown as Parameters<
      typeof proveClaudeChildExitWithReaper
    >[0]['child'],
    kill,
    stdin,
    exitPromise,
    exited: () => exited
  }
}

/** A Windows root that leaves on stdin end when `leavesOnStdinEnd`, otherwise only once killed
 *  (or, with `leavesOnKill` false, only when the test calls `leave`). */
function windowsRoot(leavesOnStdinEnd: boolean, leavesOnKill = true) {
  let exited = false
  let settle = (): void => {}
  const exitPromise = new Promise<void>((resolve) => {
    settle = resolve
  })
  const leave = (): void => {
    exited = true
    settle()
  }
  const kill = vi.fn(() => {
    if (leavesOnKill) {
      leave()
    }
    return true
  })
  const stdin = {
    end: vi.fn(() => {
      if (leavesOnStdinEnd) {
        leave()
      }
    })
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The ladder reads only pid, kill and stdin.end from its child.
    child: { pid: 4321, kill, stdin } as unknown as Parameters<
      typeof proveClaudeChildExitWithReaper
    >[0]['child'],
    kill,
    leave,
    exitPromise,
    exited: () => exited
  }
}

function windowsTree(
  root: ReturnType<typeof windowsRoot>,
  terminateWindowsTree: (rootPid: number) => Promise<boolean>
) {
  const captureDescendants = vi.fn(async () => null)
  const tree = createClaudeChildTreeReaper(root.child, {
    platform: 'win32',
    exited: root.exited,
    captureDescendants,
    terminateWindowsTree
  })
  return { tree, reap: vi.spyOn(tree, 'reap'), captureDescendants }
}

describe('Claude child exit proof ladder', () => {
  it('stops a supervised child with SIGTERM and waits out the supervisor stop before forcing', async () => {
    // Slower than the unsupervised 1.5 s grace, still inside the supervisor's own bound.
    const root = rootStoppedBySigterm(PROVIDER_SUPERVISOR_MAX_STOP_MS - 500)
    const tree = fakeTree()

    await expect(
      proveClaudeChildExitWithReaper({ ...root, supervised: true, tree }, () => tree)
    ).resolves.toBe(true)

    expect(root.stdin.end).toHaveBeenCalled()
    expect(root.kill).toHaveBeenCalledWith('SIGTERM')
    // Forcing here would SIGKILL the supervisor mid-stop and orphan Claude in its own group.
    expect(root.kill).not.toHaveBeenCalledWith('SIGKILL')
    expect(tree.reap).not.toHaveBeenCalled()
  }, 10_000)

  it('never signals an unsupervised child for the graceful stop', async () => {
    const root = rootStoppedBySigterm(0)
    const tree = fakeTree()

    await proveClaudeChildExitWithReaper({ ...root, tree }, () => tree)

    // On Windows a direct SIGTERM is TerminateProcess: stdin end stays the only graceful rung.
    expect(root.stdin.end).toHaveBeenCalled()
    expect(root.kill).not.toHaveBeenCalledWith('SIGTERM')
    expect(tree.reap).toHaveBeenCalled()
  }, 10_000)

  it('on Windows proves a close when Claude leaves on its own after its stdin ends', async () => {
    const root = windowsRoot(true)
    const terminateWindowsTree = vi.fn(async () => true)
    const { tree, reap, captureDescendants } = windowsTree(root, terminateWindowsTree)

    await expect(
      proveClaudeChildExitWithReaper({ ...root, tree, platform: 'win32' }, () => tree)
    ).resolves.toBe(true)

    // No claim about what Claude started: nothing is read, reaped or taskkilled after it left.
    expect(reap).not.toHaveBeenCalled()
    expect(terminateWindowsTree).not.toHaveBeenCalled()
    expect(captureDescendants).not.toHaveBeenCalled()
    expect(root.kill).not.toHaveBeenCalled()
    expect(tree.treeVerdict).toBe('unverifiable')
  })

  it.each([
    { taskkill: true, proven: true },
    { taskkill: false, proven: false }
  ])(
    'on Windows a forced close is proven only by taskkill: taskkill $taskkill',
    async ({ taskkill, proven }) => {
      const root = windowsRoot(false)
      const terminateWindowsTree = vi.fn(async () => taskkill)
      const { tree } = windowsTree(root, terminateWindowsTree)

      await expect(
        proveClaudeChildExitWithReaper({ ...root, tree, platform: 'win32' }, () => tree)
      ).resolves.toBe(proven)

      expect(terminateWindowsTree).toHaveBeenCalledWith(4321)
      // The root still leaves through its held handle whatever taskkill reported.
      expect(root.exited()).toBe(true)
    },
    10_000
  )

  it('on POSIX still reaps a root that left on its own and keeps the tree verdict', async () => {
    let exited = false
    const stdin = {
      end: vi.fn(() => {
        exited = true
      })
    }
    const tree = { ...fakeTree(), treeVerdict: 'unverifiable' as const }
    const input = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The ladder reads only pid, kill and stdin.end from its child.
      child: { pid: 4321, kill: vi.fn(), stdin } as unknown as Parameters<
        typeof proveClaudeChildExitWithReaper
      >[0]['child'],
      exitPromise: Promise.resolve(),
      exited: () => exited,
      tree,
      platform: 'linux' as const
    }

    await expect(proveClaudeChildExitWithReaper(input, () => tree)).resolves.toBe(false)
    expect(tree.reap).toHaveBeenCalledOnce()
  })

  it('on Windows a retried close after a failed taskkill stays unproven once the root exits', async () => {
    const root = windowsRoot(false, false)
    const terminateWindowsTree = vi.fn(async () => false)
    const { tree } = windowsTree(root, terminateWindowsTree)
    const close = () =>
      proveClaudeChildExitWithReaper({ ...root, tree, platform: 'win32' }, () => tree)

    await expect(close()).resolves.toBe(false)
    // The exit lands only after the forced wait: it is not Claude leaving on its own.
    root.leave()
    await expect(close()).resolves.toBe(false)

    expect(terminateWindowsTree).toHaveBeenCalledOnce()
    expect(tree.forcedReapAttempted).toBe(true)
    expect(tree.treeVerdict).toBe('unverifiable')
  }, 10_000)

  it.each([
    { taskkill: true, proven: true },
    { taskkill: false, proven: false }
  ])(
    'on Windows a reap outside a close keeps taskkill as the verdict: taskkill $taskkill',
    async ({ taskkill, proven }) => {
      // The transport-failure reap (stdin error, reader failure) kills the live tree itself.
      const root = windowsRoot(false)
      const terminateWindowsTree = vi.fn(async () => taskkill)
      const { tree } = windowsTree(root, terminateWindowsTree)
      await tree.reap()
      expect(root.exited()).toBe(true)

      await expect(
        proveClaudeChildExitWithReaper({ ...root, tree, platform: 'win32' }, () => tree)
      ).resolves.toBe(proven)
      expect(terminateWindowsTree).toHaveBeenCalledOnce()
    }
  )
})
