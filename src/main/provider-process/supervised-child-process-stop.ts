import type { ChildProcessHandle } from '../../shared/child-process/process-spec'
import { stopSupervisedProvider } from './provider-process-supervisor'
import { terminateProviderProcessTree } from './provider-process-teardown'

type SupervisedChild = Pick<ChildProcessHandle, 'pid' | 'kill' | 'exitCode' | 'signalCode' | 'once'>

/**
 * Stops a provider supervisor child: `request` asks it to stop (SIGTERM unless given), and its
 * tree is forced, filed under `site`, only after the supervisor's full stop time. True when forced.
 */
export async function stopSupervisedChildProcess(
  child: SupervisedChild,
  { site, request = () => child.kill('SIGTERM') }: { site: string; request?: () => void }
): Promise<boolean> {
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null
  if (exited()) {
    return false
  }
  return stopSupervisedProvider({
    request: () => {
      try {
        request()
      } catch {
        // The process may exit between the exit check and the request.
      }
    },
    exitPromise: new Promise<void>((resolve) => child.once('exit', () => resolve())),
    exited,
    force: () => terminateProviderProcessTree(child, { site }),
    supervised: true
  })
}
