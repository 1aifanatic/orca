import {
  appendFileSync,
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats
} from 'node:fs'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  ClaudeProfileSurfaceError,
  warnClaudeProfile,
  type ClaudeProfileReport,
  type ClaudeProfileSurfaceOutcome
} from './claude-profile-report'

export const CLAUDE_PROFILE_MERGE_SUFFIX = '.orca-profile-merge'
const HISTORY = 'history.jsonl'
const PENDING = `${HISTORY}${CLAUDE_PROFILE_MERGE_SUFFIX}`
// Identity of the Windows hardlink Orca created; replaced on every relink.
const LINK_RECORD = `${HISTORY}.orca-profile-link`

export function lstatIfPresent(file: string): BigIntStats | undefined {
  try {
    return lstatSync(file, { bigint: true })
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
    return undefined
  }
}

export function fileIdentity(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}`
}

function appendHistory(destination: string, bytes: Buffer): void {
  if (bytes.length === 0) {
    return
  }
  const size = statSync(destination).size
  let separator = false
  if (size > 0) {
    const fd = openSync(destination, 'r')
    try {
      const tail = Buffer.alloc(1)
      readSync(fd, tail, 0, 1, size - 1)
      separator = tail[0] !== 10
    } finally {
      closeSync(fd)
    }
  }
  appendFileSync(destination, separator ? Buffer.concat([Buffer.from('\n'), bytes]) : bytes)
}

function isSharedFile(file: string, destination: string): boolean {
  const stats = lstatIfPresent(file)
  return (
    stats !== undefined &&
    fileIdentity(stats) === fileIdentity(statSync(destination, { bigint: true }))
  )
}

function drainHistory(pending: string, destination: string): void {
  // Why: a pending name for the shared file itself would re-append its own tail forever.
  if (isSharedFile(pending, destination)) {
    return
  }
  const content = readFileSync(pending)
  let offset = 0
  try {
    const stored = Number(readFileSync(`${pending}.offset`, 'utf8'))
    if (Number.isSafeInteger(stored) && stored >= 0 && stored <= content.length) {
      offset = stored
    }
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  }
  appendHistory(destination, content.subarray(offset))
  // Advance only after append; a crash can duplicate records, never discard unattempted bytes.
  writeFileSync(`${pending}.offset`, `${content.length}\n`, { mode: 0o600 })
}

function pendingGeneration(name: string): number | null {
  if (name === PENDING) {
    return 0
  }
  const suffix = name.slice(PENDING.length + 1)
  return name.startsWith(`${PENDING}-`) && /^\d+$/.test(suffix) ? Number(suffix) : null
}

/** A leftover cursor without its file still reserves the name, so a new file never inherits it. */
function nextFreePath(base: string): string {
  for (let generation = 0; ; generation++) {
    const candidate = generation === 0 ? base : `${base}-${generation}`
    if (!lstatIfPresent(candidate) && !lstatIfPresent(`${candidate}.offset`)) {
      return candidate
    }
  }
}

function readLinkRecord(profile: string): string | null {
  try {
    return readFileSync(join(profile, LINK_RECORD), 'utf8').trim()
  } catch {
    return null
  }
}

function writeLinkRecord(profile: string, shared: BigIntStats): void {
  if (readLinkRecord(profile) !== fileIdentity(shared)) {
    writeFileAtomically(join(profile, LINK_RECORD), `${fileIdentity(shared)}\n`, { mode: 0o600 })
  }
}

export function mergeClaudeProfilePromptHistory(
  profile: string,
  home: string,
  platform: NodeJS.Platform,
  report: ClaudeProfileReport
): ClaudeProfileSurfaceOutcome {
  const source = join(profile, HISTORY)
  const destination = join(home, HISTORY)
  if (!lstatIfPresent(destination)) {
    writeFileSync(destination, '', { flag: 'wx', mode: 0o600 })
  }
  const pendings: { name: string; generation: number }[] = []
  for (const item of readdirSync(profile, { withFileTypes: true })) {
    const generation = pendingGeneration(item.name)
    if (item.isFile() && generation !== null) {
      pendings.push({ name: item.name, generation })
    }
  }
  // Why: directory order is not creation order; generations keep prompts in the order they were written.
  pendings.sort((left, right) => left.generation - right.generation)
  for (const { name } of pendings) {
    drainHistory(join(profile, name), destination)
  }
  const current = lstatIfPresent(source)
  if (current?.isSymbolicLink()) {
    return realpathSync(source) === realpathSync(destination) ? 'unchanged' : 'user-owned'
  }
  if (current && !current.isFile()) {
    return 'user-owned'
  }
  const shared = statSync(destination, { bigint: true })
  if (platform === 'win32' && current && fileIdentity(current) === fileIdentity(shared)) {
    writeLinkRecord(profile, shared)
    return 'unchanged'
  }
  if (platform === 'win32' && statSync(profile).dev !== statSync(home).dev) {
    throw new ClaudeProfileSurfaceError(
      'cross-filesystem',
      'Prompt history stays private across volumes'
    )
  }
  // Why: the old shared file still held under Orca's link means the default was replaced or cleared;
  // draining it would bring back history the user removed.
  const replaced = current !== undefined && fileIdentity(current) === readLinkRecord(profile)
  let aside: string | undefined
  if (current) {
    aside = nextFreePath(join(profile, replaced ? `${HISTORY}.orca-profile-conflict` : PENDING))
    renameSync(source, aside)
  }
  try {
    if (platform === 'win32') {
      linkSync(destination, source)
    } else {
      symlinkSync(destination, source)
    }
  } catch (error) {
    if (aside && !lstatIfPresent(source)) {
      renameSync(aside, source)
    }
    throw new ClaudeProfileSurfaceError('link-failed', String(error))
  }
  if (platform === 'win32') {
    writeLinkRecord(profile, shared)
  }
  if (aside && replaced) {
    const detail = `Shared prompt history was replaced; the old copy is kept at ${aside}`
    warnClaudeProfile(report, HISTORY, new ClaudeProfileSurfaceError('retained-conflict', detail))
  } else if (aside && isSharedFile(aside, destination)) {
    // Why: a second name for the shared file holds nothing new, and would replay it if the default is replaced.
    unlinkSync(aside)
  } else if (aside) {
    drainHistory(aside, destination)
  }
  return 'linked'
}
