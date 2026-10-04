import { spawnProcess } from '../../shared/child-process/run-process'
import { RetryableProcessExitProof } from '../../shared/child-process/retryable-process-exit-proof'
import type { ProviderProcessLaunch } from './provider-process-launch'
import { createProviderSpawnSpec } from './provider-process-supervisor'
import { terminateProviderProcessTree } from './provider-process-teardown'
import {
  closeProviderProcess,
  type ProviderProcessClosePolicy,
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
  /** Preserve callers which accept Node's close event as root exit evidence. */
  closeEventIsExit?: boolean
}

export type ManagedProviderProcess = {
  child: ReturnType<typeof spawnProcess>
  supervised: boolean
  readonly exited: boolean
  readonly processless: boolean
  readonly rootVerdict: ProviderProcessVerdict
  readonly teardownUnproven: boolean
  readonly exitPromise: Promise<void>
  onExit(listener: (exit: ProviderProcessExit) => void): void
  terminateTree(): Promise<boolean>
  close(tree?: ProviderProcessTree): Promise<ProviderProcessVerdict>
}

/** One child owns its exit observation and every retry of an unconfirmed close. */
export function spawnManagedProviderProcess(
  launch: ProviderProcessLaunch,
  options: ManagedProviderProcessOptions
): ManagedProviderProcess {
  const platform = options.platform ?? process.platform
  const spec = createProviderSpawnSpec(launch, options.inheritedEnv ?? process.env, platform)
  const child = (options.spawnImpl ?? spawnProcess)({
    program: spec.program,
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env,
    detached: spec.detached,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const policy = options.policy(spec.supervised)
  const listeners = new Set<(exit: ProviderProcessExit) => void>()
  let observed: ProviderProcessExit | null = null
  let spawnFailed = false
  let teardownUnproven = false
  const exitProof = new RetryableProcessExitProof<ProviderProcessVerdict>(
    (verdict) => verdict === 'exited'
  )
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
    if (processless || options.closeEventIsExit) {
      observeExit({ code, signal, processless })
    }
  })
  const exited = (): boolean => observed !== null
  const terminateTree = (): Promise<boolean> =>
    terminateProviderProcessTree(child, { site: options.site, platform })

  return {
    child,
    supervised: spec.supervised,
    exitPromise,
    get exited() {
      return observed !== null && !observed.processless
    },
    get processless() {
      return observed?.processless ?? false
    },
    get rootVerdict() {
      return observed ? 'exited' : 'unverifiable'
    },
    get teardownUnproven() {
      return teardownUnproven && observed !== null
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
      if (observed && !policy.requireTreeExit) {
        return Promise.resolve('exited')
      }
      return exitProof.run(async () => {
        const result = await closeProviderProcess({
          child,
          exitPromise,
          exited,
          supervised: spec.supervised,
          policy,
          tree,
          terminateTree
        })
        if (result.teardownAccepted !== undefined) {
          teardownUnproven = !result.teardownAccepted
        }
        return result.verdict
      })
    }
  }
}
