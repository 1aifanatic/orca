import { defineMethod, type RpcContext } from '../core'
import { saveClipboardImageBufferAsTempFile } from '../../../window/clipboard-image-temp-file'
import { ChunkedUploadRegistry, nextChunkedUploadLength } from '../../chunked-upload-registry'
import { recordMobileClipboardImagePath } from '../mobile-clipboard-image-provenance'
import {
  AbortImageUpload,
  AppendImageUploadChunk,
  CommitImageUpload,
  SaveImageAsTempFile,
  StartImageUpload
} from '../../../../shared/rpc-contract/clipboard-params'
import { decodeClipboardImageUpload } from './clipboard-image-upload-decoding'
export { CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from '../../../../shared/rpc-contract/clipboard-params'
export const CLIPBOARD_IMAGE_UPLOAD_MAX_CONCURRENT = 8
const CLIPBOARD_IMAGE_UPLOAD_TTL_MS = 5 * 60 * 1000

type ClipboardImageUpload = {
  expectedLength: number
  connectionId?: string | null
  mobileClientId?: string
  chunks: string[]
  receivedLength: number
}

const clipboardImageUploads = new ChunkedUploadRegistry<ClipboardImageUpload>({
  maxConcurrent: CLIPBOARD_IMAGE_UPLOAD_MAX_CONCURRENT,
  ttlMs: CLIPBOARD_IMAGE_UPLOAD_TTL_MS,
  tooManyMessage: 'Too many clipboard image uploads are in progress',
  notFoundMessage: 'Clipboard image upload was not found'
})

function mobileClientId(ctx: RpcContext): string | undefined {
  if (ctx.clientKind !== 'mobile') {
    return undefined
  }
  const clientId = ctx.clientId?.trim()
  if (!clientId) {
    throw new Error('Clipboard image upload requires an authenticated mobile client')
  }
  return clientId
}

function assertMobileUploadOwner(
  upload: ClipboardImageUpload,
  ctx: RpcContext
): string | undefined {
  const clientId = mobileClientId(ctx)
  if (clientId && upload.mobileClientId !== clientId) {
    throw new Error('Clipboard image upload was not found')
  }
  return clientId
}

export const CLIPBOARD_METHODS = [
  defineMethod({
    name: 'clipboard.saveImageAsTempFile',
    params: SaveImageAsTempFile,
    handler: async (params, ctx) => {
      const clientId = mobileClientId(ctx)
      const path = await saveClipboardImageBufferAsTempFile(
        Buffer.from(params.contentBase64, 'base64'),
        {
          connectionId: params.connectionId
        }
      )
      if (clientId && !params.connectionId) {
        recordMobileClipboardImagePath(clientId, path)
      }
      return path
    }
  }),
  defineMethod({
    name: 'clipboard.startImageUpload',
    params: StartImageUpload,
    handler: (params, ctx) => {
      const mobileClient = mobileClientId(ctx)
      const uploadId = clipboardImageUploads.create(() => ({
        expectedLength: params.expectedBase64Length,
        connectionId: params.connectionId,
        mobileClientId: mobileClient,
        chunks: [],
        receivedLength: 0
      }))
      return { uploadId }
    }
  }),
  defineMethod({
    name: 'clipboard.appendImageUploadChunk',
    params: AppendImageUploadChunk,
    handler: (params, ctx) => {
      const upload = clipboardImageUploads.require(params.uploadId)
      assertMobileUploadOwner(upload, ctx)
      const nextLength = nextChunkedUploadLength(
        upload,
        params.offset,
        params.contentBase64.length,
        {
          outOfOrder: 'Clipboard image chunk offset is out of order',
          exceeded: 'Clipboard image upload exceeded expected size'
        }
      )
      upload.chunks.push(params.contentBase64)
      upload.receivedLength = nextLength
      clipboardImageUploads.touch(params.uploadId)
      return { receivedBase64Length: upload.receivedLength }
    }
  }),
  defineMethod({
    name: 'clipboard.commitImageUpload',
    params: CommitImageUpload,
    handler: async (params, ctx) => {
      const upload = clipboardImageUploads.require(params.uploadId)
      const clientId = assertMobileUploadOwner(upload, ctx)
      try {
        if (upload.receivedLength !== upload.expectedLength) {
          throw new Error('Clipboard image upload is incomplete')
        }
        const path = await saveClipboardImageBufferAsTempFile(
          decodeClipboardImageUpload(upload.chunks),
          {
            connectionId: upload.connectionId
          }
        )
        if (clientId && !upload.connectionId) {
          recordMobileClipboardImagePath(clientId, path)
        }
        return path
      } finally {
        // Why: failed SSH or filesystem commits must not leave bounded upload
        // memory pinned until TTL cleanup.
        clipboardImageUploads.delete(params.uploadId)
      }
    }
  }),
  defineMethod({
    name: 'clipboard.abortImageUpload',
    params: AbortImageUpload,
    handler: (params, ctx) => {
      const upload = clipboardImageUploads.peek(params.uploadId)
      if (upload) {
        assertMobileUploadOwner(upload, ctx)
      }
      clipboardImageUploads.delete(params.uploadId)
      return { aborted: true }
    }
  })
]

export function resetClipboardImageUploadsForTest(): void {
  clipboardImageUploads.clear()
}
