import { spawnProcess } from '../../shared/child-process/run-process'
import { RetryableProcessExitProof } from '../../shared/child-process/retryable-process-exit-proof'
import type { ProviderProcessLaunch } from './provider-process-launch'
import {
  PROVIDER_SUPERVISOR_MAX_STOP_MS,
  createProviderSpawnSpec
} from './provider-process-supervisor'
import { terminateProviderProcessTree } from './provider-process-teardown'
import {
  closeProviderProcess,
  type ProviderProcessClosePolicy,
  type ProviderProcessCloseResult,
  type ProviderProcessTree,
  type ProviderProcessVerdict
} from './provider-process-close'

export type ProviderProcessExit = {
  code: number | null
  signal: NodeJS.Signals | null
  processless: boolean
}

type ManagedProviderProcessOptions = {
  site: string
  policy: (supervised: boolean) => ProviderProcessClosePolicy
  spawnImpl?: typeof spawnProcess
  platform?: NodeJS.Platform
  inheritedEnv?: NodeJS.ProcessEnv
  acceptClose: (result: ProviderProcessCloseResult) => boolean
}

export type ManagedProviderProcess = {
  child: ReturnType<typeof spawnProcess>
  supervised: boolean
  readonly processless: boolean
  readonly rootVerdict: ProviderProcessVerdict
  readonly lastCloseResult: ProviderProcessCloseResult | null
  readonly exitPromise: Promise<void>
  onExit(listener: (exit: ProviderProcessExit) => void): void
  terminateTree(): Promise<boolean>
  close(tree?: ProviderProcessTree): Promise<ProviderProcessCloseResult>
}

/** One child owns its exit observation and every retry of an unconfirmed close. */
export function spawnManagedProviderProcess(
  launch: ProviderProcessLaunch,
  options: ManagedProviderProcessOptions
): ManagedProviderProcess {
  const platform = options.platform ?? process.platform
  const spec = createProviderSpawnSpec(launch, options.inheritedEnv ?? process.env, platform)
  const policy = options.policy(spec.supervised)
  if (spec.supervised && !(policy.gracefulExitMs >= PROVIDER_SUPERVISOR_MAX_STOP_MS)) {
    throw new RangeError(
      `Supervised provider graceful exit must wait at least ${PROVIDER_SUPERVISOR_MAX_STOP_MS} ms; received ${policy.gracefulExitMs} ms`
    )
  }
  const child = (options.spawnImpl ?? spawnProcess)({
    program: spec.program,
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env,
    detached: spec.detached,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const listeners = new Set<(exit: ProviderProcessExit) => void>()
  let observed: ProviderProcessExit | null = null
  let spawnFailed = false
  let lastCloseResult: ProviderProcessCloseResult | null = null
  const exitProof = new RetryableProcessExitProof(options.acceptClose)
  let resolveExit = (): void => {}
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  const observeExit = (exit: ProviderProcessExit): void => {
    if (observed) {
      return
    }
    observed = exit
    resolveExit()
    for (const listener of listeners) {
      listener(exit)
    }
    listeners.clear()
  }
  child.on('exit', (code, signal) => observeExit({ code, signal, processless: false }))
  child.on('error', () => {
    spawnFailed ||= child.pid === undefined
  })
  child.on('close', (code, signal) => {
    const processless = spawnFailed && child.pid === undefined
    if (processless) {
      observeExit({ code, signal, processless })
    }
  })
  const rootVerdict = (): ProviderProcessVerdict =>
    observed ? 'exited' : child.pid === undefined ? 'unverifiable' : 'live'
  const terminateTree = (): Promise<boolean> =>
    terminateProviderProcessTree(child, { site: options.site, platform })

  return {
    child,
    supervised: spec.supervised,
    exitPromise,
    get processless() {
      return observed?.processless ?? false
    },
    get rootVerdict() {
      return rootVerdict()
    },
    get lastCloseResult() {
      return lastCloseResult
    },
    onExit(listener) {
      if (observed) {
        listener(observed)
      } else {
        listeners.add(listener)
      }
    },
    terminateTree,
    close(tree) {
      if (observed && !tree) {
        return Promise.resolve({ root: 'exited', tree: 'unverifiable' })
      }
      return exitProof.run(async () => {
        const result = await closeProviderProcess({
          child,
          exitPromise,
          rootVerdict,
          supervised: spec.supervised,
          policy,
          tree,
          terminateTree
        })
        lastCloseResult = result
        return result
      })
    }
  }
}
