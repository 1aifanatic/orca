// How the host recognizes its own attachment store in what a client sends: a stored file is
// `<store root>/<upload id>/<name>`, and only the upload id is needed to know which upload it is.

import { isAbsolute, join, relative, sep } from 'node:path'
import { AGENT_SESSION_ATTACHMENTS_DIR_NAME } from '../../../shared/agent-session-attachments'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'

export const AGENT_SESSION_ATTACHMENT_PART_FILE = '.upload.part'

const UPLOAD_ID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UPLOAD_ID = new RegExp(`^${UPLOAD_ID_SOURCE}$`)

export function agentSessionAttachmentStoreRoot(stateDirectory: string): string {
  return join(stateDirectory, AGENT_SESSION_ATTACHMENTS_DIR_NAME)
}

export function isAgentSessionAttachmentUploadId(value: string): boolean {
  return UPLOAD_ID.test(value)
}

/** The upload a stored file belongs to, or null for anything that is not exactly a committed file
 *  directly in an upload directory of this store. */
export function parseAgentSessionAttachmentStorePath(
  root: string,
  filePath: string
): { uploadId: string; name: string } | null {
  if (!isAbsolute(filePath)) {
    return null
  }
  const inside = relative(root, filePath)
  const segments = inside.split(sep)
  const [uploadId, name] = segments
  if (
    inside === '' ||
    isAbsolute(inside) ||
    segments.length !== 2 ||
    !uploadId ||
    !name ||
    !isAgentSessionAttachmentUploadId(uploadId) ||
    name === AGENT_SESSION_ATTACHMENT_PART_FILE
  ) {
    return null
  }
  return { uploadId, name }
}

export type AgentSessionAttachmentReferences = {
  /** Uploads in this host's store. */
  uploadIds: Set<string>
  /** Store-shaped references whose root is not this host's: another server's, or a stale path. */
  foreign: number
}

function normalizedRoot(root: string, platform: NodeJS.Platform): string {
  const forward = root.replace(/\\/g, '/')
  return platform === 'win32' ? forward.toLowerCase() : forward
}

/**
 * Every store reference in a message body: image paths and file references in its text alike.
 * Matched on the decoded body by `<store dir>/<upload id>`, so quoting or a file name with spaces
 * cannot hide one; Windows paths match with either separator and in any case.
 */
export function agentSessionAttachmentReferences(
  root: string,
  body: AgentJournalMessageItem,
  platform: NodeJS.Platform = process.platform
): AgentSessionAttachmentReferences {
  const references: AgentSessionAttachmentReferences = { uploadIds: new Set(), foreign: 0 }
  const ownRoot = normalizedRoot(root, platform)
  const pattern = new RegExp(
    `${AGENT_SESSION_ATTACHMENTS_DIR_NAME}[\\\\/](${UPLOAD_ID_SOURCE})(?![0-9a-z-])`,
    platform === 'win32' ? 'gi' : 'g'
  )
  for (const block of body.blocks) {
    const text =
      block.type === 'text' ? block.text : block.type === 'image-ref' ? block.path : undefined
    if (!text) {
      continue
    }
    for (const match of text.matchAll(pattern)) {
      const rootEnd = match.index + AGENT_SESSION_ATTACHMENTS_DIR_NAME.length
      const prefix = text.slice(Math.max(0, rootEnd - root.length), rootEnd)
      const uploadId = match[1]?.toLowerCase()
      if (uploadId && normalizedRoot(prefix, platform) === ownRoot) {
        references.uploadIds.add(uploadId)
      } else {
        references.foreign++
      }
    }
  }
  return references
}
