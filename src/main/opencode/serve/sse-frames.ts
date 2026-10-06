import { appendCompactedStringChunk } from '../../../shared/string-chunk-compaction'

export type OpenCodeSseFrame = { data: string; event: string; id: string }

/** Frames only; the versioned session adapter owns the JSON inside `data`. */
export class OpenCodeSseFrames {
  private line: string[] = []
  private lineBytes = 0
  private data: string[] = []
  private dataBytes = 0
  private event = ''
  private id = ''
  private skipLf = false

  constructor(private readonly maxFrameBytes = 8 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new RangeError('SSE frame limit must be a positive integer')
    }
  }

  *push(text: string): Generator<OpenCodeSseFrame> {
    let start = 0
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]
      if (this.skipLf) {
        this.skipLf = false
        if (char === '\n') {
          start = index + 1
          continue
        }
      }
      if (char !== '\r' && char !== '\n') {
        continue
      }
      this.appendLine(text.slice(start, index))
      const frame = this.finishLine()
      if (frame) {
        yield frame
      }
      this.skipLf = char === '\r'
      start = index + 1
    }
    this.appendLine(text.slice(start))
  }

  private appendLine(part: string): void {
    if (!part) {
      return
    }
    this.lineBytes += Buffer.byteLength(part, 'utf8')
    if (this.lineBytes > this.maxFrameBytes) {
      throw new Error('OpenCode SSE line exceeds limit')
    }
    appendCompactedStringChunk(this.line, part)
  }

  private finishLine(): OpenCodeSseFrame | null {
    const line = this.line.join('')
    this.line = []
    this.lineBytes = 0
    if (line === '') {
      const frame = this.data.length
        ? { data: this.data.join('').slice(0, -1), event: this.event || 'message', id: this.id }
        : null
      this.data = []
      this.dataBytes = 0
      this.event = ''
      return frame
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const raw = colon === -1 ? '' : line.slice(colon + 1)
    const value = raw.startsWith(' ') ? raw.slice(1) : raw
    if (field === 'data') {
      this.dataBytes += Buffer.byteLength(value, 'utf8') + 1
      if (this.dataBytes > this.maxFrameBytes) {
        throw new Error('OpenCode SSE frame exceeds limit')
      }
      appendCompactedStringChunk(this.data, `${value}\n`)
    } else if (field === 'event') {
      this.event = value
    } else if (field === 'id' && !value.includes('\0')) {
      this.id = value
    }
    return null
  }
}
