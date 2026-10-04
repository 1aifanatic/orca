// The server-owned store for files a client attaches to a structured chat.
//
// `<root>/<hashed session id>/<upload id>/<original file name>`: one directory per upload keeps the
// user's file name intact (agents read meaning into it) without two uploads colliding. Bytes land
// in a hidden part file and are renamed into place on commit, so a stored name is always complete.
//
// Nothing here records what is owed: whether a file may go is re-derived on every sweep from the
// host's chat records and journal (see `sweepAgentSessionAttachments`).

import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { extname, join, relative, isAbsolute, sep } from 'node:path'
import {
  AGENT_SESSION_ATTACHMENT_PREVIEW_MAX_BYTES,
  sanitizeAgentSessionAttachmentName,
  type AgentSessionAttachmentUploadCommitResult
} from '../../../shared/agent-session-attachments'
import { journalPathSegment } from '../agent-session-journal/journal-paths'
import {
  ChunkedUploadRegistry,
  nextChunkedUploadLength
} from './chunked-upload-registry'

export const AGENT_SESSION_ATTACHMENT_PART_FILE = '.upload.part'
const UPLOAD_MAX_CONCURRENT = 8
const UPLOAD_IDLE_TTL_MS = 5 * 60 * 1000
const NOT_FOUND = 'Attachment upload was not found'

const PREVIEW_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

type InFlightUpload = {
  callerKey: string
  sessionId: string
  uploadDir: string
  name: string
  expectedLength: number
  receivedLength: number
  writing: boolean
}

export class AgentSessionAttachmentStore {
  private readonly uploads = new ChunkedUploadRegistry<InFlightUpload>({
    maxConcurrent: UPLOAD_MAX_CONCURRENT,
    ttlMs: UPLOAD_IDLE_TTL_MS,
    tooManyMessage: 'Too many attachment uploads are in progress',
    notFoundMessage: NOT_FOUND,
    onExpire: (upload) => void removeQuietly(upload.uploadDir)
  })

  constructor(readonly rootDir: string) {}

  sessionDirectory(sessionId: string): string {
    return join(this.rootDir, journalPathSegment(sessionId))
  }

  /** Upload ids whose bytes are still arriving; the sweep leaves their directories alone. */
  isUploadInFlight(uploadId: string): boolean {
    return this.uploads.has(uploadId)
  }

  async startUpload(args: {
    callerKey: string
    sessionId: string
    name: string
    byteLength: number
  }): Promise<{ uploadId: string }> {
    const sessionDir = this.sessionDirectory(args.sessionId)
    const name = sanitizeAgentSessionAttachmentName(args.name)
    const uploadId = this.uploads.create((id) => ({
      callerKey: args.callerKey,
      sessionId: args.sessionId,
      uploadDir: join(sessionDir, id),
      name,
      expectedLength: args.byteLength,
      receivedLength: 0,
      writing: false
    }))
    const uploadDir = join(sessionDir, uploadId)
    try {
      await mkdir(uploadDir, { recursive: true })
      await writeFile(join(uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE), '', { flag: 'wx' })
    } catch (error) {
      this.uploads.delete(uploadId)
      await removeQuietly(uploadDir)
      throw error
    }
    return { uploadId }
  }

  async appendChunk(args: {
    callerKey: string
    uploadId: string
    offset: number
    contentBase64: string
  }): Promise<{ receivedBytes: number }> {
    const upload = this.requireOwned(args.uploadId, args.callerKey)
    if (upload.writing) {
      throw new Error('Attachment chunk is already being written')
    }
    const bytes = Buffer.from(args.contentBase64, 'base64')
    const nextLength = nextChunkedUploadLength(upload, args.offset, bytes.byteLength, {
      outOfOrder: 'Attachment chunk offset is out of order',
      exceeded: 'Attachment upload exceeded its declared size'
    })
    upload.writing = true
    try {
      await appendFile(join(upload.uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE), bytes)
      upload.receivedLength = nextLength
    } finally {
      upload.writing = false
    }
    this.uploads.touch(args.uploadId)
    return { receivedBytes: upload.receivedLength }
  }

  async commitUpload(args: {
    callerKey: string
    uploadId: string
  }): Promise<AgentSessionAttachmentUploadCommitResult> {
    const upload = this.requireOwned(args.uploadId, args.callerKey)
    if (upload.writing) {
      throw new Error('Attachment chunk is still being written')
    }
    this.uploads.delete(args.uploadId)
    try {
      if (upload.receivedLength !== upload.expectedLength) {
        throw new Error('Attachment upload is incomplete')
      }
      const finalPath = join(upload.uploadDir, upload.name)
      await rename(join(upload.uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE), finalPath)
      return { path: finalPath, name: upload.name, byteLength: upload.receivedLength }
    } catch (error) {
      await removeQuietly(upload.uploadDir)
      throw error
    }
  }

  async abortUpload(args: { callerKey: string; uploadId: string }): Promise<{ aborted: true }> {
    const upload = this.uploads.peek(args.uploadId)
    if (upload) {
      if (upload.callerKey !== args.callerKey) {
        throw new Error(NOT_FOUND)
      }
      this.uploads.delete(args.uploadId)
      await removeQuietly(upload.uploadDir)
    }
    return { aborted: true }
  }

  /** A stored image's bytes, for a client that shows it. Anything outside the store is refused. */
  async readPreview(
    filePath: string
  ): Promise<{ content: string; isBinary: true; isImage: true; mimeType: string }> {
    const mimeType = PREVIEW_IMAGE_MIME_TYPES[extname(filePath).toLowerCase()]
    if (!isAbsolute(filePath) || !mimeType) {
      throw new Error('Not an attachment image')
    }
    const [root, resolved] = await Promise.all([realpath(this.rootDir), realpath(filePath)])
    const inside = relative(root, resolved)
    const segments = inside.split(sep)
    // `<session>/<upload>/<name>` exactly: never a part file, never anything shallower or deeper.
    if (
      inside === '' ||
      isAbsolute(inside) ||
      segments.length !== 3 ||
      segments.some((segment) => segment === '..') ||
      segments[2] === AGENT_SESSION_ATTACHMENT_PART_FILE
    ) {
      throw new Error('Not an attachment image')
    }
    const info = await stat(resolved)
    if (!info.isFile()) {
      throw new Error('Not an attachment image')
    }
    if (info.size > AGENT_SESSION_ATTACHMENT_PREVIEW_MAX_BYTES) {
      throw new Error('Attachment image is too large to preview')
    }
    const content = (await readFile(resolved)).toString('base64')
    return { content, isBinary: true, isImage: true, mimeType }
  }

  clearInFlightForTests(): void {
    this.uploads.clear()
  }

  private requireOwned(uploadId: string, callerKey: string): InFlightUpload {
    const upload = this.uploads.require(uploadId)
    // Another client's upload reads as absent, not as forbidden.
    if (upload.callerKey !== callerKey) {
      throw new Error(NOT_FOUND)
    }
    return upload
  }
}

export async function removeQuietly(path: string): Promise<void> {
  // Cleanup is best effort: a file that will not go is retried by the next sweep.
  await rm(path, { recursive: true, force: true }).catch(() => {})
}

let installedStore: AgentSessionAttachmentStore | null = null

/** Installed with the structured host, which owns the state directory the store lives in. */
export function setAgentSessionAttachmentStore(store: AgentSessionAttachmentStore | null): void {
  installedStore = store
}

export function getAgentSessionAttachmentStore(): AgentSessionAttachmentStore | null {
  return installedStore
}
