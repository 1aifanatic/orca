import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { getOrcaUserDataPath } from './codex-home-paths'
import type { CodexHookHashes } from './codex-hook-trust-derivation'
import { CODEX_MANAGED_EVENT_LABELS } from './codex-hook-definition'
import type { CodexEventLabel } from './config-toml-trust'

/**
 * Orca's record of what each Codex binary answered about its hook: the
 * `codex --version` behind a binary fingerprint, and Codex's hashes per
 * version and hook command. Lets a reconcile that finds nothing new spawn
 * nothing, in the app and in the CLI's process. Orca's own file under
 * userData; any read failure reads as empty, so it is only ever re-derived.
 */
type BinaryRecord = {
  fingerprint: string
  codexVersion: string | null
  /** Why this binary gives no hashes; only failures that recur with the same bytes. */
  failure: string | null
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
    if (parsed && typeof parsed === 'object') {
      const binaries = Reflect.get(parsed, 'binaries')
      const versions = Reflect.get(parsed, 'versions')
      return {
        binaries: binaries && typeof binaries === 'object' ? { ...binaries } : {},
        versions: versions && typeof versions === 'object' ? { ...versions } : {}
      }
    }
  } catch {
    // Why: absent or unreadable reads as empty; the next reconcile re-derives.
  }
  return { binaries: {}, versions: {} }
}

function readHashes(value: unknown): CodexHookHashes | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const hashes: Partial<Record<CodexEventLabel, string>> = {}
  for (const label of CODEX_MANAGED_EVENT_LABELS) {
    const hash = Reflect.get(value, label)
    if (typeof hash === 'string' && hash.startsWith('sha256:')) {
      hashes[label] = hash
    }
  }
  return Object.keys(hashes).length > 0 ? hashes : null
}

function binaryKey(codexPath: string): string {
  return normalizeRuntimePathForComparison(codexPath)
}

/** The memoized answer for this binary as it is on disk now; null when it must be asked. */
export function readMemoizedCodexHookTrust(
  codexPath: string,
  command: string,
  fingerprint: string = fingerprintCodex(codexPath)
): CodexHookTrustAnswer | null {
  const memo = readMemo()
  const binary = memo.binaries[binaryKey(codexPath)]
  if (!binary || typeof binary !== 'object' || binary.fingerprint !== fingerprint) {
    return null
  }
  if (typeof binary.failure === 'string') {
    return { codexVersion: binary.codexVersion, hashes: null, failure: binary.failure }
  }
  return typeof binary.codexVersion === 'string'
    ? readMemoizedVersionHashes(binary.codexVersion, command, memo)
    : null
}

export function readMemoizedVersionHashes(
  codexVersion: string,
  command: string,
  memo: MemoFile = readMemo()
): CodexHookTrustAnswer | null {
  const record = memo.versions[codexVersion]
  const hashes = record?.command === command ? readHashes(record.hashes) : null
  return hashes ? { codexVersion, hashes, failure: null } : null
}

/** Records a binary's answer, and its version's hashes when it has some. Never throws. */
export function memoizeCodexHookTrust(
  codexPath: string,
  fingerprint: string,
  command: string,
  answer: CodexHookTrustAnswer
): void {
  try {
    const memo = readMemo()
    const binaries = withoutKey(memo.binaries, binaryKey(codexPath))
    binaries[binaryKey(codexPath)] = {
      fingerprint,
      codexVersion: answer.codexVersion,
      failure: answer.failure
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

/** Forgets a binary's answer, so the next reconcile asks it again. Never throws. */
export function forgetCodexHookTrust(codexPath: string): void {
  try {
    const memo = readMemo()
    if (memo.binaries[binaryKey(codexPath)]) {
      writeFileAtomically(
        getCodexHookTrustMemoPath(),
        `${JSON.stringify({ ...memo, binaries: withoutKey(memo.binaries, binaryKey(codexPath)) }, null, 2)}\n`
      )
    }
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
