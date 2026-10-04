import type { SpawnedProcess } from '../../shared/child-process/run-process'
import { waitForProcessExitUntil } from './provider-process-exit-deadline'

export type ProviderProcessVerdict = 'live' | 'unverifiable' | 'exited'

export type ProviderProcessTree = {
  capture(): Promise<void>
  refresh?: () => Promise<void>
  reap(): Promise<ProviderProcessVerdict>
  readonly treeVerdict: ProviderProcessVerdict
}

export type ProviderProcessClosePolicy = {
  gracefulExitMs: number
  forcedExitMs: number
  signalSupervisorOnClose?: boolean
}

export type ProviderProcessCloseInput = {
  child: Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin'>
  exitPromise: Promise<void>
  rootVerdict: () => ProviderProcessVerdict
  supervised?: boolean
  policy: ProviderProcessClosePolicy
  tree?: ProviderProcessTree
  terminateTree: () => Promise<boolean>
}

export type ProviderProcessCloseResult = {
  root: ProviderProcessVerdict
  tree: ProviderProcessVerdict
  /** Acceptance of the fallback teardown is separate from observed process exit. */
  teardownAccepted?: boolean
}

/** The supervisor owns the POSIX signal ladder; its wrapper must outlive that ladder. */
export async function closeProviderProcess(
  input: ProviderProcessCloseInput
): Promise<ProviderProcessCloseResult> {
  const { child, policy, tree } = input
  if (tree) {
    await tree.capture()
  }
  try {
    child.stdin?.end()
  } catch {
    // A broken pipe still owes the reap.
  }
  if (input.supervised && policy.signalSupervisorOnClose && input.rootVerdict() !== 'exited') {
    child.kill('SIGTERM')
  }
  let reaped = false
  let teardownAccepted: boolean | undefined
  if (input.rootVerdict() !== 'exited') {
    await waitForProcessExitUntil(input.exitPromise, policy.gracefulExitMs)
    if (input.rootVerdict() !== 'exited') {
      reaped = true
      await tree?.refresh?.()
      if (tree) {
        await tree.reap()
      } else {
        teardownAccepted = await input.terminateTree()
      }
      await waitForProcessExitUntil(input.exitPromise, policy.forcedExitMs)
    }
  }
  if (!reaped && input.rootVerdict() === 'exited' && tree && tree.treeVerdict !== 'exited') {
    await tree.reap()
  }
  return {
    root: input.rootVerdict(),
    tree: tree?.treeVerdict ?? 'unverifiable',
    ...(teardownAccepted === undefined ? {} : { teardownAccepted })
  }
}
