// Replays a captured agent transcript the way onPtyData consumes it, frame by frame.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { projectTerminalVisibleLines } from './orca-runtime-terminal-projection'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import { buildPreview } from './terminal-tail-state'
import { buildTerminalWaitText } from './terminal-wait-tail-state'

const CHUNK_CHARS = 64

export function readTranscriptFixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.txt`), 'utf8')
}

export type ReplayFrame = { screenLines: string[]; waitText: string }

/** Feeds the bytes the way onPtyData does: one emulator grid, one line-folded wait text. */
export async function* replayTranscript(
  data: string,
  cols: number,
  rows: number
): AsyncGenerator<ReplayFrame> {
  const emulator = new HeadlessEmulator({ cols, rows })
  let lines: string[] = []
  let partialLine = ''
  let pendingAnsi = ''
  let redrawCursor: ReturnType<typeof appendNormalizedToTailBuffer>['redrawCursor'] = null
  try {
    for (let offset = 0; offset < data.length; offset += CHUNK_CHARS) {
      const chunk = data.slice(offset, offset + CHUNK_CHARS)
      await emulator.write(chunk)
      const normalized = normalizeTerminalChunk(chunk, pendingAnsi)
      pendingAnsi = normalized.pendingAnsi
      const tail = appendNormalizedToTailBuffer(lines, partialLine, normalized.text, redrawCursor)
      lines = tail.lines
      partialLine = tail.partialLine
      redrawCursor = tail.redrawCursor
      yield {
        screenLines: projectTerminalVisibleLines(emulator).lines,
        waitText: buildTerminalWaitText(lines, partialLine, buildPreview(lines, partialLine))
      }
    }
  } finally {
    emulator.dispose()
  }
}

export async function finalTranscriptFrame(
  name: string,
  cols: number,
  rows: number
): Promise<ReplayFrame> {
  let last: ReplayFrame | null = null
  for await (const frame of replayTranscript(readTranscriptFixture(name), cols, rows)) {
    last = frame
  }
  if (!last) {
    throw new Error(`empty fixture ${name}`)
  }
  return last
}
