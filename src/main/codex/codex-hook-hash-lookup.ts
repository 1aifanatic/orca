import { dedupeInFlightRun } from '../in-flight-run-dedupe'
import { deriveCodexHookHashes, probeCodexVersion } from './codex-hook-trust-derivation'
import {
  fingerprintCodex,
  memoizeCodexHookTrust,
  MISSING_CODEX_FINGERPRINT,
  readMemoizedCodexHookTrust,
  readMemoizedVersionHashes,
  readPersistedCodexHookFailure,
  readProcessCodexHookTrust,
  type CodexHookTrustAnswer
} from './codex-hook-trust-memo'

// Why retried soon: a timeout at a loaded boot must not cost status until a restart.
const TRANSIENT_FAILURE_RETRY_MS = 60_000

const derivations = new Map<string, Promise<CodexHookTrustAnswer>>()
const transientFailures = new Map<string, { retryAt: number; answer: CodexHookTrustAnswer }>()

/**
 * Codex's hashes for Orca's entry from `codexPath`: from this process's memo,
 * else asked of Codex (its version first, then a throwaway `hooks/list` for a
 * new version) when `mayAskCodex`. Never throws; one question per binary at a time.
 */
export function lookupCodexHookHashes(
  codexPath: string,
  command: string,
  mayAskCodex: boolean
): Promise<CodexHookTrustAnswer> {
  const fingerprint = fingerprintCodex(codexPath)
  if (fingerprint === MISSING_CODEX_FINGERPRINT) {
    return Promise.resolve({
      codexVersion: null,
      hashes: null,
      failure: `Orca could not find Codex at ${codexPath}`
    })
  }
  const known = readProcessCodexHookTrust(codexPath, command, fingerprint)
  if (known) {
    return Promise.resolve(known)
  }
  if (!mayAskCodex) {
    // Why: only the app asks Codex; the CLI's process reads what the app learned.
    return Promise.resolve(
      readMemoizedCodexHookTrust(codexPath, command, fingerprint) ?? {
        codexVersion: null,
        hashes: null,
        failure: 'Orca has not asked Codex yet'
      }
    )
  }
  const transient = transientFailures.get(fingerprint)
  if (transient && transient.retryAt > Date.now()) {
    return Promise.resolve(transient.answer)
  }
  return dedupeInFlightRun(derivations, fingerprint, () =>
    askCodexForHookHashes(codexPath, command, fingerprint)
  )
}

async function askCodexForHookHashes(
  codexPath: string,
  command: string,
  fingerprint: string
): Promise<CodexHookTrustAnswer> {
  try {
    // Why re-probe a persisted binary: a shim's bytes stay the same when the codex behind it updates.
    const probe = await probeCodexVersion(codexPath, 30_000)
    if (!probe.version) {
      return rememberTransient(
        fingerprint,
        {
          codexVersion: null,
          hashes: null,
          failure: `${codexPath} did not report its version`
        },
        probe.timedOut
      )
    }
    const failure = readPersistedCodexHookFailure(codexPath, fingerprint, probe.version)
    const answer: CodexHookTrustAnswer & { transient?: boolean } = failure
      ? { codexVersion: probe.version, hashes: null, failure }
      : (readMemoizedVersionHashes(probe.version, command) ??
        (await deriveCodexHookHashes(codexPath, command, probe.version)))
    if (answer.transient) {
      return rememberTransient(fingerprint, answer, true)
    }
    transientFailures.delete(fingerprint)
    memoizeCodexHookTrust(codexPath, fingerprint, command, answer)
    return answer
  } catch (error) {
    return rememberTransient(
      fingerprint,
      {
        codexVersion: null,
        hashes: null,
        failure: error instanceof Error ? error.message : String(error)
      },
      true
    )
  }
}

function rememberTransient(
  fingerprint: string,
  answer: CodexHookTrustAnswer,
  transient: boolean
): CodexHookTrustAnswer {
  if (!transient) {
    return answer
  }
  const remembered = answer.hashes ? answer : { ...answer, transient: true }
  transientFailures.set(fingerprint, {
    retryAt: Date.now() + TRANSIENT_FAILURE_RETRY_MS,
    answer: remembered
  })
  return remembered
}

export const _internals = {
  resetForTesting(): void {
    derivations.clear()
    transientFailures.clear()
  }
}
