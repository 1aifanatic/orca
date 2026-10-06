/**
 * The activation fence tokens this desktop's processes hold, kept beside the profile so a later
 * launch can tell a fence its own quit or crash left from one another desktop holds (BUG-23).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'

export const ORCAD_HELD_FENCE_TOKENS_FILE_NAME = 'orcad-held-fence-tokens.json'
// A process holds a handful at most; the cap only bounds tokens a release never confirmed.
const MAX_HELD = 64

type HeldFence = { token: string; pid: number }

let file: string | null = null

export function initOrcadHeldFenceTokenFile(dataFile: string): void {
  file = join(dirname(dataFile), ORCAD_HELD_FENCE_TOKENS_FILE_NAME)
}

function readHeld(): HeldFence[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file ?? '', 'utf-8'))
    return Array.isArray(parsed) ? parsed.filter(isHeldFence) : []
  } catch {
    return []
  }
}

function isHeldFence(entry: unknown): entry is HeldFence {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'token' in entry &&
    typeof entry.token === 'string' &&
    'pid' in entry &&
    Number.isSafeInteger(entry.pid)
  )
}

function writeHeld(held: HeldFence[]): void {
  if (file) {
    writeDurableSecureJsonFile(file, held.slice(-MAX_HELD))
  }
}

/** Before the lock command: a reply lost after the lock landed still leaves a provable token. */
export function rememberHeldOrcadFence(token: string): void {
  if (file) {
    writeHeld([...readHeld(), { token, pid: process.pid }])
  }
}

export function forgetHeldOrcadFence(token: string): void {
  const held = file ? readHeld() : []
  if (held.some((entry) => entry.token === token)) {
    writeHeld(held.filter((entry) => entry.token !== token))
  }
}

/** Only a positively exited earlier process; a live or reused pid never qualifies. */
export function orcadFenceHeldByExitedProcess(token: string): boolean {
  const entry = file ? readHeld().find((held) => held.token === token) : undefined
  if (!entry || entry.pid === process.pid) {
    return false
  }
  try {
    process.kill(entry.pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}

export function hasHeldOrcadFences(): boolean {
  return file !== null && readHeld().length > 0
}
