import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { isPlainObject } from '../agent-hooks/hooks-json-read'
import { getOrcaUserDataPath } from './codex-home-paths'
import type { CodexHookHashes } from './codex-hook-trust-derivation'
import { CODEX_MANAGED_EVENT_LABELS } from './codex-hook-definition'
import type { CodexEventLabel } from './config-toml-trust'

/**
 * Orca's record of what each Codex binary answered about its hook: the
 * `codex --version` behind a binary fingerprint, and Codex's hashes per
 * version and hook command. Kept in this process and in Orca's own file under
 * userData, so a reconcile that finds nothing new spawns nothing and an
 * unwritable file costs no extra spawns. Any read failure reads as empty, so
 * it is only ever re-derived.
 */
type BinaryRecord = {
  fingerprint: string
  codexVersion: string | null
  /** Why this binary gives no hashes; only failures that recur with the same bytes. */
  failure: string | null
  /** Why this binary refused Orca's approval in ~/.codex; its managed homes still use the hashes. */
  refusal: string | null
}

type VersionRecord = { command: string; hashes: CodexHookHashes }

type MemoFile = {
  binaries: Record<string, BinaryRecord>
  versions: Record<string, VersionRecord>
}

export type CodexHookTrustAnswer =
  | { codexVersion: string; hashes: CodexHookHashes; failure: null }
  | { codexVersion: string | null; hashes: null; failure: string }

// Why a cap: one record per Codex version or path ever seen would otherwise accumulate.
const MAX_RECORDS = 8
export const MISSING_CODEX_FINGERPRINT = 'missing'

// Why in-process too: a persisted record from an earlier process is only trusted after this one re-probed the version.
const processRefusals = new Map<
  string,
  { fingerprint: string; codexVersion: string; refusal: string }
>()
const processAnswers = new Map<
  string,
  { fingerprint: string; command: string; answer: CodexHookTrustAnswer }
>()

export function getCodexHookTrustMemoPath(): string {
  return join(getOrcaUserDataPath(), 'codex-hook-trust.json')
}

// Why these fields: they change when an update or reinstall replaces the binary behind the path.
export function fingerprintCodex(codexPath: string): string {
  try {
    const realPath = realpathSync(codexPath)
    const info = statSync(realPath)
    return `${realPath}:${info.size}:${info.mtimeMs}:${info.ino}`
  } catch {
    return MISSING_CODEX_FINGERPRINT
  }
}

function readMemo(): MemoFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getCodexHookTrustMemoPath(), 'utf-8'))
    if (isPlainObject(parsed)) {
      return { binaries: readBinaries(parsed.binaries), versions: readVersions(parsed.versions) }
    }
  } catch {
    // Why: absent or unreadable reads as empty; the next reconcile re-derives.
  }
  return { binaries: {}, versions: {} }
}

function readBinaries(value: unknown): Record<string, BinaryRecord> {
  return isPlainObject(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([key, record]) =>
          isPlainObject(record) && typeof record.fingerprint === 'string'
            ? [
                [
                  key,
                  {
                    fingerprint: record.fingerprint,
                    codexVersion:
                      typeof record.codexVersion === 'string' ? record.codexVersion : null,
                    failure: typeof record.failure === 'string' ? record.failure : null,
                    refusal: typeof record.refusal === 'string' ? record.refusal : null
                  }
                ]
              ]
            : []
        )
      )
    : {}
}

function readVersions(value: unknown): Record<string, VersionRecord> {
  return isPlainObject(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([key, record]) => {
          const hashes = isPlainObject(record) ? readHashes(record.hashes) : null
          return isPlainObject(record) && typeof record.command === 'string' && hashes
            ? [[key, { command: record.command, hashes }]]
            : []
        })
      )
    : {}
}

function readHashes(value: unknown): CodexHookHashes | null {
  if (!isPlainObject(value)) {
    return null
  }
  const hashes: Partial<Record<CodexEventLabel, string>> = {}
  for (const label of CODEX_MANAGED_EVENT_LABELS) {
    const hash = value[label]
    if (typeof hash === 'string' && hash.startsWith('sha256:')) {
      hashes[label] = hash
    }
  }
  return Object.keys(hashes).length > 0 ? hashes : null
}

function binaryKey(codexPath: string): string {
  return normalizeRuntimePathForComparison(codexPath)
}

/** What this process already learned for this binary as it is on disk now; null when it must be asked. */
export function readProcessCodexHookTrust(
  codexPath: string,
  command: string,
  fingerprint: string = fingerprintCodex(codexPath)
): CodexHookTrustAnswer | null {
  const known = processAnswers.get(binaryKey(codexPath))
  return known?.fingerprint === fingerprint && known.command === command ? known.answer : null
}

/**
 * The persisted answer for this binary as it is on disk now. In the app it is
 * only a hint: a shim keeps its bytes when the codex behind it changes, so the
 * app re-probes the version first (readPersistedCodexHookFailure).
 */
export function readMemoizedCodexHookTrust(
  codexPath: string,
  command: string,
  fingerprint: string = fingerprintCodex(codexPath)
): CodexHookTrustAnswer | null {
  const inProcess = readProcessCodexHookTrust(codexPath, command, fingerprint)
  if (inProcess) {
    return inProcess
  }
  const memo = readMemo()
  const binary = memo.binaries[binaryKey(codexPath)]
  if (!binary || binary.fingerprint !== fingerprint) {
    return null
  }
  if (binary.failure !== null) {
    return { codexVersion: binary.codexVersion, hashes: null, failure: binary.failure }
  }
  return binary.codexVersion !== null
    ? readMemoizedVersionHashes(binary.codexVersion, command, memo)
    : null
}

/** Why ~/.codex refused Orca's approval from this binary at this version; null when it did not. */
export function readCodexHookRealHomeRefusal(
  codexPath: string,
  fingerprint: string,
  codexVersion: string
): string | null {
  const known = processRefusals.get(binaryKey(codexPath))
  if (known?.fingerprint === fingerprint && known.codexVersion === codexVersion) {
    return known.refusal
  }
  const binary = readMemo().binaries[binaryKey(codexPath)]
  return binary?.fingerprint === fingerprint && binary.codexVersion === codexVersion
    ? binary.refusal
    : null
}

/** Records that ~/.codex refused this binary's approval, until the binary changes or is forgotten. */
export function memoizeCodexHookRealHomeRefusal(
  codexPath: string,
  fingerprint: string,
  codexVersion: string,
  refusal: string
): void {
  processRefusals.set(binaryKey(codexPath), { fingerprint, codexVersion, refusal })
  try {
    const memo = readMemo()
    const record = memo.binaries[binaryKey(codexPath)]
    if (record?.fingerprint === fingerprint) {
      const binaries = withoutKey(memo.binaries, binaryKey(codexPath))
      binaries[binaryKey(codexPath)] = { ...record, codexVersion, refusal }
      writeFileAtomically(
        getCodexHookTrustMemoPath(),
        `${JSON.stringify({ ...memo, binaries: newest(binaries) }, null, 2)}\n`
      )
    }
  } catch (error) {
    console.warn('[codex-hook-trust] could not record the refusal:', error)
  }
}

/** A persisted failure for this binary, when the version it was recorded for is still the one it reports. */
export function readPersistedCodexHookFailure(
  codexPath: string,
  fingerprint: string,
  codexVersion: string
): string | null {
  const binary = readMemo().binaries[binaryKey(codexPath)]
  return binary?.fingerprint === fingerprint && binary.codexVersion === codexVersion
    ? binary.failure
    : null
}

export function readMemoizedVersionHashes(
  codexVersion: string,
  command: string,
  memo: MemoFile = readMemo()
): CodexHookTrustAnswer | null {
  const record = memo.versions[codexVersion]
  return record?.command === command ? { codexVersion, hashes: record.hashes, failure: null } : null
}

/** Records a binary's answer, and its version's hashes when it has some. Never throws. */
export function memoizeCodexHookTrust(
  codexPath: string,
  fingerprint: string,
  command: string,
  answer: CodexHookTrustAnswer
): void {
  processAnswers.set(binaryKey(codexPath), { fingerprint, command, answer })
  try {
    const memo = readMemo()
    const binaries = withoutKey(memo.binaries, binaryKey(codexPath))
    binaries[binaryKey(codexPath)] = {
      fingerprint,
      codexVersion: answer.codexVersion,
      failure: answer.failure,
      refusal: null
    }
    let versions = memo.versions
    if (answer.hashes) {
      versions = withoutKey(versions, answer.codexVersion)
      versions[answer.codexVersion] = { command, hashes: answer.hashes }
    }
    writeFileAtomically(
      getCodexHookTrustMemoPath(),
      `${JSON.stringify({ binaries: newest(binaries), versions: newest(versions) }, null, 2)}\n`
    )
  } catch (error) {
    console.warn('[codex-hook-trust] could not record Codex hook hashes:', error)
  }
}

/**
 * Forgets a binary's answer and its version's hashes, so the next reconcile
 * asks Codex again from scratch. Never throws.
 */
export function forgetCodexHookTrust(codexPath: string): void {
  const key = binaryKey(codexPath)
  const versions = [processAnswers.get(key)?.answer.codexVersion]
  processAnswers.delete(key)
  processRefusals.delete(key)
  try {
    const memo = readMemo()
    versions.push(memo.binaries[key]?.codexVersion)
    let nextVersions = memo.versions
    for (const version of versions) {
      if (version) {
        nextVersions = withoutKey(nextVersions, version)
      }
    }
    writeFileAtomically(
      getCodexHookTrustMemoPath(),
      `${JSON.stringify({ binaries: withoutKey(memo.binaries, key), versions: nextVersions }, null, 2)}\n`
    )
  } catch (error) {
    console.warn('[codex-hook-trust] could not forget Codex hook hashes:', error)
  }
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

// Why insertion order: a record is re-inserted on every write, so the oldest go first.
function newest<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).slice(-MAX_RECORDS))
}

export const _internals = {
  resetForTesting(): void {
    processAnswers.clear()
    processRefusals.clear()
  }
}
