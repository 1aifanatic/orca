import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { isMissingProfileFile, readClaudeProfileObject } from './claude-profile-paths'

export type ProfileSurfaceOutcome =
  | 'linked'
  | 'synced'
  | 'merged'
  | 'unchanged'
  | 'user-owned'
  | 'absent'
export type ClaudeProfileLedger = {
  version: 1
  files: Record<string, string>
  keys: Record<string, Record<string, string>>
}

export function readClaudeProfileLedger(file: string): ClaudeProfileLedger {
  const result = readClaudeProfileObject(file)
  if (result.kind === 'unavailable') {
    throw result.error
  }
  const ledger: ClaudeProfileLedger = { version: 1, files: {}, keys: {} }
  if (result.kind === 'absent') {
    return ledger
  }
  const { files, keys } = result.value
  if (files && typeof files === 'object') {
    for (const [key, value] of Object.entries(files)) {
      if (typeof value === 'string') {
        ledger.files[key] = value
      }
    }
  }
  if (keys && typeof keys === 'object') {
    for (const [surface, entries] of Object.entries(keys)) {
      if (!entries || typeof entries !== 'object') {
        continue
      }
      const values: Record<string, string> = {}
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value === 'string') {
          values[key] = value
        }
      }
      ledger.keys[surface] = values
    }
  }
  return ledger
}

export function linkClaudeProfileDirectory(
  source: string,
  target: string,
  platform: NodeJS.Platform
): ProfileSurfaceOutcome {
  let canonical: string
  try {
    canonical = realpathSync(source)
  } catch (error) {
    if (isMissingProfileFile(error)) {
      return 'absent'
    }
    throw error
  }
  let entry: ReturnType<typeof lstatSync> | undefined
  try {
    entry = lstatSync(target)
  } catch (error) {
    if (!isMissingProfileFile(error)) {
      throw error
    }
  }
  if (entry?.isSymbolicLink()) {
    try {
      return realpathSync(target) === canonical ? 'unchanged' : 'user-owned'
    } catch (error) {
      if (!isMissingProfileFile(error)) {
        throw error
      }
      unlinkSync(target)
    }
  } else if (entry) {
    if (!entry.isDirectory() || readdirSync(target).length > 0) {
      return 'user-owned'
    }
    rmdirSync(target)
  }
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(canonical, target, platform === 'win32' ? 'junction' : 'dir')
  return 'linked'
}

export function syncClaudeProfileFile(
  source: string,
  target: string,
  ledger: ClaudeProfileLedger
): ProfileSurfaceOutcome {
  let desired: string
  try {
    desired = readFileSync(source, 'utf8')
  } catch (error) {
    if (isMissingProfileFile(error)) {
      return 'absent'
    }
    throw error
  }
  const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
  try {
    if (lstatSync(target).isSymbolicLink()) {
      return 'user-owned'
    }
    const current = hash(readFileSync(target, 'utf8'))
    if (current === hash(desired)) {
      ledger.files[target] = current
      return 'unchanged'
    }
    if (ledger.files[target] !== current) {
      return 'user-owned'
    }
  } catch (error) {
    if (!isMissingProfileFile(error)) {
      throw error
    }
  }
  writeFileAtomically(target, desired, { mode: 0o600 })
  ledger.files[target] = hash(desired)
  return 'synced'
}

export function mergeClaudeProfileKeys(
  target: Record<string, unknown>,
  desired: Record<string, unknown>,
  written: Record<string, string>
): boolean {
  let changed = false
  for (const [key, value] of Object.entries(desired)) {
    const serialized = JSON.stringify(value)
    const current = key in target ? JSON.stringify(target[key]) : undefined
    if (current !== serialized && current !== undefined && written[key] !== current) {
      continue
    }
    if (current !== serialized) {
      target[key] = value
      changed = true
    }
    written[key] = serialized
  }
  return changed
}
