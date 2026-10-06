import { basename, extname, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { IMAGE_FILE_MIME_TYPES } from '../../shared/image-file-extensions'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../shared/node-bounded-file-reader'
import type { NativeChatImageRefBlock } from '../../shared/native-chat-types'

const NATIVE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const OPENCODE_NATIVE_IMAGE_MAX_BYTES = 20 * 1024 * 1024

export type OpenCodePromptFile = { uri: string; name: string; mime: string }
export type OpenCodePromptContent = { text: string; files: OpenCodePromptFile[] }

export class OpenCodeAttachmentError extends Error {
  constructor(readonly failure: SubmissionRejectionFact) {
    super('OpenCode attachment cannot be sent')
    this.name = 'OpenCodeAttachmentError'
  }
}

function invalid(reason: 'noSource' | 'unsupportedType' | 'notAFile'): never {
  throw new OpenCodeAttachmentError(
    agentSessionFailureFact('attachmentInvalid', {
      attachment: { reason }
    })
  )
}

async function prepareImage(
  block: NativeChatImageRefBlock,
  signal: AbortSignal
): Promise<{ file: OpenCodePromptFile; byteLength: number }> {
  if (block.url?.startsWith('data:')) {
    const maximum = Math.ceil(OPENCODE_NATIVE_IMAGE_MAX_BYTES / 3) * 4 + 256
    if (block.url.length > maximum) {
      throw new OpenCodeAttachmentError(
        agentSessionFailureFact('attachmentInvalid', {
          attachment: { reason: 'tooLarge', limit: OPENCODE_NATIVE_IMAGE_MAX_BYTES }
        })
      )
    }
    const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(block.url)
    if (!match || !NATIVE_IMAGE_MIMES.has(match[1]!) || match[2]!.length % 4 !== 0) {
      return invalid('unsupportedType')
    }
    const bytes = Buffer.from(match[2]!, 'base64')
    if (bytes.length > OPENCODE_NATIVE_IMAGE_MAX_BYTES) {
      throw new OpenCodeAttachmentError(
        agentSessionFailureFact('attachmentInvalid', {
          attachment: { reason: 'tooLarge', limit: OPENCODE_NATIVE_IMAGE_MAX_BYTES }
        })
      )
    }
    return {
      file: { uri: block.url, name: (block.alt ?? 'image').slice(0, 256), mime: match[1]! },
      byteLength: bytes.length
    }
  }
  let filePath = block.path
  if (!filePath && block.url?.startsWith('file:')) {
    try {
      filePath = fileURLToPath(block.url)
    } catch {
      return invalid('noSource')
    }
  }
  if (!filePath || !isAbsolute(filePath) || filePath.length > 4096) {
    return invalid('noSource')
  }
  const mime = IMAGE_FILE_MIME_TYPES[extname(filePath).toLowerCase()]
  if (!mime || !NATIVE_IMAGE_MIMES.has(mime)) {
    return invalid('unsupportedType')
  }
  let byteLength: number
  try {
    const result = await readNodeFileWithinLimit(filePath, OPENCODE_NATIVE_IMAGE_MAX_BYTES, {
      regularFileOnly: true,
      signal
    })
    byteLength = result.buffer.length
  } catch (error) {
    if (error instanceof NodeFileReadTooLargeError) {
      throw new OpenCodeAttachmentError(
        agentSessionFailureFact('attachmentInvalid', {
          attachment: { reason: 'tooLarge', limit: OPENCODE_NATIVE_IMAGE_MAX_BYTES }
        })
      )
    }
    if (error instanceof Error && error.message === 'Expected a regular file') {
      return invalid('notAFile')
    }
    throw new OpenCodeAttachmentError(agentSessionFailureFact('attachmentUnreadable'))
  }
  return { file: { uri: pathToFileURL(filePath).href, name: basename(filePath), mime }, byteLength }
}

/** Validate the aggregate image budget before mutating the native session. */
export async function prepareOpenCodePromptContent(
  body: AgentJournalMessageItem
): Promise<OpenCodePromptContent> {
  if (body.role !== 'user') {
    return invalid('unsupportedType')
  }
  const text: string[] = []
  const files: OpenCodePromptFile[] = []
  const signal = AbortSignal.timeout(15_000)
  let bytes = 0
  for (const block of body.blocks) {
    if (signal.aborted) {
      throw new OpenCodeAttachmentError(agentSessionFailureFact('attachmentUnreadable'))
    }
    if (block.type === 'text') {
      text.push(block.text)
    } else if (block.type === 'image-ref') {
      const image = await prepareImage(block, signal)
      bytes += image.byteLength
      if (bytes > OPENCODE_NATIVE_IMAGE_MAX_BYTES) {
        throw new OpenCodeAttachmentError(
          agentSessionFailureFact('attachmentInvalid', {
            attachment: { reason: 'totalTooLarge', limit: OPENCODE_NATIVE_IMAGE_MAX_BYTES }
          })
        )
      }
      files.push(image.file)
    } else {
      return invalid('unsupportedType')
    }
  }
  return { text: text.join('\n'), files }
}
