import { lstat, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { DRAG_TEMP_COPY_DIR_PATTERN } from './dragged-temp-file-copy'
import {
  ensureOwnedTempStagingRoot,
  isSafeOwnedDirectory,
  sweepExpiredOwnedDirectories
} from './owned-temp-staging-root'

// Images pasted or dropped (macOS drag copies) into a chat live here rather than in OS temp, so
// a draft restored after a reboot still names a real file. One directory per image, swept by age.
const ATTACHMENT_ROOT_NAME = 'native-chat-attachments'
const ATTACHMENT_DIR_PREFIX = 'chat-image-'
const ATTACHMENT_DIR_PATTERN = /^chat-image-[A-Za-z0-9]{6}$/
// Why: an unsent draft can wait weeks; past this its chip shows as missing and blocks Send.
export const NATIVE_CHAT_ATTACHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SWEEP_FIRST_DELAY_MS = 30 * 1000
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

export function getNativeChatAttachmentRoot(): string {
  return join(getAppEnvironment().getPath('userData'), ATTACHMENT_ROOT_NAME)
}

/** Writes one chat attachment under Orca's own storage and returns its path. */
export async function saveNativeChatAttachmentFile(
  fileName: string,
  contents: Buffer
): Promise<string> {
  const root = getNativeChatAttachmentRoot()
  if (!(await ensureOwnedTempStagingRoot(root))) {
    throw new Error('Chat attachment storage is not a private directory')
  }
  const filePath = join(await mkdtemp(join(root, ATTACHMENT_DIR_PREFIX)), fileName)
  await writeFile(filePath, contents)
  return filePath
}

/** The attachment root as a filesystem root, so a restored draft's previews still resolve. */
export function getNativeChatAttachmentAllowedRoots(): string[] {
  return hasAppEnvironment() ? [resolve(getNativeChatAttachmentRoot())] : []
}

export async function sweepExpiredNativeChatAttachments(nowMs = Date.now()): Promise<void> {
  const root = getNativeChatAttachmentRoot()
  try {
    if (!isSafeOwnedDirectory(await lstat(root))) {
      return
    }
  } catch {
    return
  }
  await sweepExpiredOwnedDirectories(root, {
    nowMs,
    ttlMs: NATIVE_CHAT_ATTACHMENT_TTL_MS,
    ownsEntry: (name) => ATTACHMENT_DIR_PATTERN.test(name) || DRAG_TEMP_COPY_DIR_PATTERN.test(name)
  })
}

let sweepScheduled = false

/** Sweep shortly after startup, then hourly, so a long-running app still expires attachments. */
export function scheduleNativeChatAttachmentSweep(): void {
  if (sweepScheduled) {
    return
  }
  sweepScheduled = true
  const sweep = (): void => {
    void sweepExpiredNativeChatAttachments().catch(() => undefined)
  }
  setTimeout(sweep, SWEEP_FIRST_DELAY_MS).unref()
  setInterval(sweep, SWEEP_INTERVAL_MS).unref()
}
