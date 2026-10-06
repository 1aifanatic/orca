import { mkdtemp, mkdir, open, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  OPENCODE_NATIVE_IMAGE_MAX_BYTES,
  prepareOpenCodePromptContent
} from './opencode-structured-prompt-content'
import type { NativeChatBlock } from '../../shared/native-chat-types'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAN0lEQVR42u3PsQkAAAzDsPz/dHpDh2wCzwalybTxvgEAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+HY6S/hqZZnSdgAAAABJRU5ErkJggg==',
  'base64'
)
const prepare = (blocks: NativeChatBlock[]) =>
  prepareOpenCodePromptContent({ kind: 'message', role: 'user', blocks })

describe('OpenCode image preparation', () => {
  it('sends image-only and mixed prompts as execution-host file references', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-opencode-image-'))
    const image = join(directory, 'red-blue.png')
    await writeFile(image, png)
    const file = { uri: pathToFileURL(image).href, name: 'red-blue.png', mime: 'image/png' }
    expect(await prepare([{ type: 'image-ref', path: image }])).toEqual({ text: '', files: [file] })
    expect(
      await prepare([
        { type: 'text', text: 'Colors?' },
        { type: 'image-ref', url: file.uri }
      ])
    ).toEqual({ text: 'Colors?', files: [file] })
  })

  it('preserves already-inline captured image data without reading a file', async () => {
    const uri = `data:image/png;base64,${png.toString('base64')}`
    expect(await prepare([{ type: 'image-ref', url: uri, alt: 'red-blue.png' }])).toEqual({
      text: '',
      files: [{ uri, name: 'red-blue.png', mime: 'image/png' }]
    })
  })

  it('rejects unsupported formats, directories and missing files before native dispatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-opencode-image-invalid-'))
    await mkdir(join(directory, 'folder.png'))
    await expect(
      prepare([{ type: 'image-ref', path: join(directory, 'drawing.svg') }])
    ).rejects.toMatchObject({
      failure: { kind: 'attachmentInvalid', attachment: { reason: 'unsupportedType' } }
    })
    await expect(
      prepare([{ type: 'image-ref', path: join(directory, 'folder.png') }])
    ).rejects.toMatchObject({
      failure: { kind: 'attachmentInvalid', attachment: { reason: 'notAFile' } }
    })
    await expect(
      prepare([{ type: 'image-ref', path: join(directory, 'missing.png') }])
    ).rejects.toMatchObject({
      failure: { kind: 'attachmentUnreadable' }
    })
  })

  it('rejects a sparse oversized file without reading its contents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-opencode-image-limit-'))
    const image = join(directory, 'large.png')
    const handle = await open(image, 'w')
    await handle.truncate(OPENCODE_NATIVE_IMAGE_MAX_BYTES + 1)
    await handle.close()
    await expect(prepare([{ type: 'image-ref', path: image }])).rejects.toMatchObject({
      failure: {
        kind: 'attachmentInvalid',
        attachment: { reason: 'tooLarge', limit: OPENCODE_NATIVE_IMAGE_MAX_BYTES }
      }
    })
  })

  it('rejects an oversized aggregate before any provider mutation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-opencode-image-aggregate-'))
    const image = join(directory, 'aggregate.png')
    const handle = await open(image, 'w')
    await handle.truncate(OPENCODE_NATIVE_IMAGE_MAX_BYTES / 2 + 1)
    await handle.close()
    await expect(
      prepare([
        { type: 'image-ref', path: image },
        { type: 'image-ref', path: image }
      ])
    ).rejects.toMatchObject({
      failure: {
        kind: 'attachmentInvalid',
        attachment: { reason: 'totalTooLarge', limit: OPENCODE_NATIVE_IMAGE_MAX_BYTES }
      }
    })
  })
})
