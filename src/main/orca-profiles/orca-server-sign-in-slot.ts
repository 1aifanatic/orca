import {
  ORCA_ACCOUNT_APPROVE_IN_BROWSER_RUNTIME_CAPABILITY,
  ORCA_ACCOUNT_SERVER_SIGN_IN_RUNTIME_CAPABILITY
} from '../../shared/orca-account-runtime-capabilities'
import type { OrcaServerSignIn } from './orca-server-sign-in'

export type OrcaServerSignInSource = OrcaServerSignIn | (() => Promise<OrcaServerSignIn>)

let installedSource: OrcaServerSignInSource | null = null
let resolvedInstance: OrcaServerSignIn | null = null
let loadingPromise: Promise<OrcaServerSignIn | null> | null = null
let generation = 0

/** One account per host process; the runtime advertises the capability only once installed. */
export function installOrcaServerSignIn(server: OrcaServerSignInSource | null): void {
  generation += 1
  resolvedInstance?.dispose()
  resolvedInstance = typeof server === 'function' ? null : server
  installedSource = server
  loadingPromise = null
}

export function getOrcaServerSignIn(): OrcaServerSignIn | null {
  return resolvedInstance
}

export function resolveOrcaServerSignIn(): Promise<OrcaServerSignIn | null> {
  if (resolvedInstance) {
    return Promise.resolve(resolvedInstance)
  }
  const source = installedSource
  if (!source) {
    return Promise.resolve(null)
  }
  if (typeof source !== 'function') {
    resolvedInstance = source
    return Promise.resolve(source)
  }
  if (!loadingPromise) {
    const loadGeneration = generation
    const loading = source()
      .then((instance) => {
        if (generation !== loadGeneration) {
          instance.dispose()
          return resolvedInstance
        }
        resolvedInstance = instance
        return instance
      })
      .catch((error) => {
        if (loadingPromise === loading) {
          loadingPromise = null
        }
        throw error
      })
    loadingPromise = loading
  }
  return loadingPromise
}

/** Only a host that installed its account sign-in can be signed in by a client. */
export function orcaAccountRuntimeCapabilities(): string[] {
  return installedSource
    ? [
        ORCA_ACCOUNT_SERVER_SIGN_IN_RUNTIME_CAPABILITY,
        ORCA_ACCOUNT_APPROVE_IN_BROWSER_RUNTIME_CAPABILITY
      ]
    : []
}
