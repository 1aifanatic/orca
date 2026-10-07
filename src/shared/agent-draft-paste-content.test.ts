import { describe, expect, it } from 'vitest'
import {
  AGENT_DRAFT_PASTE_MAX_BYTES,
  chunkAgentDraftPasteContent,
  sendAgentDraftPasteContentToWriter
} from './agent-draft-paste-content'
import {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  wrapTerminalBracketedPasteText
} from './terminal-bracketed-paste-text'

describe('shared desktop paste content', () => {
  it('normalizes LF/CRLF/CR and ESC without changing apostrophes or Unicode', async () => {
    const writes: string[] = []
    await expect(
      sendAgentDraftPasteContentToWriter("a'🦄\nLF\r\nCRLF\rCR\x1b", (data) => {
        writes.push(data)
        return true
      })
    ).resolves.toBe(true)
    expect(writes).toEqual(["\x1b[200~a'🦄\rLF\rCRLF\rCR␛\x1b[201~"])
  })
  it('preserves main’s known stray-low-surrogate bytes when a supplementary character overflows a chunk', () => {
    // The existing overflow bug is corrected separately from launch ownership.
    expect(chunkAgentDraftPasteContent(`${'a'.repeat(7)}🦄`, 8)).toEqual([
      BRACKETED_PASTE_START,
      'a'.repeat(7),
      '🦄\uDD84',
      BRACKETED_PASTE_END
    ])
  })
  it('uses a single frame up to the sanitized 64 KiB content boundary, then 16 KiB chunks', async () => {
    const writes: string[] = []
    const write = (data: string) => {
      writes.push(data)
      return true
    }
    await sendAgentDraftPasteContentToWriter('x'.repeat(64 * 1024), write)
    expect(writes).toEqual([wrapTerminalBracketedPasteText('x'.repeat(64 * 1024))])
    writes.length = 0
    await sendAgentDraftPasteContentToWriter('x'.repeat(64 * 1024 + 1), write)
    expect(writes).toEqual([
      BRACKETED_PASTE_START,
      ...Array.from({ length: 4 }, () => 'x'.repeat(16 * 1024)),
      'x',
      BRACKETED_PASTE_END
    ])
  })
  it('accepts 16 MiB of content plus markers and rejects oversize sanitized content before any write', async () => {
    let bytes = 0
    expect(
      await sendAgentDraftPasteContentToWriter('x'.repeat(AGENT_DRAFT_PASTE_MAX_BYTES), (data) => {
        bytes += Buffer.byteLength(data)
        return true
      })
    ).toBe(true)
    expect(bytes).toBe(AGENT_DRAFT_PASTE_MAX_BYTES + 12)
    let count = 0
    expect(
      await sendAgentDraftPasteContentToWriter(
        `${'x'.repeat(AGENT_DRAFT_PASTE_MAX_BYTES - 1)}\x1b`,
        () => {
          count++
          return true
        }
      )
    ).toBe(false)
    expect(count).toBe(0)
  })
  it('closes a partial paste after rejected content without replaying a chunk', async () => {
    const writes: string[] = []
    const sent = await sendAgentDraftPasteContentToWriter('x'.repeat(70_000), (data) => {
      writes.push(data)
      return writes.length !== 2
    })
    expect(sent).toBe(false)
    expect(writes).toEqual([BRACKETED_PASTE_START, 'x'.repeat(16 * 1024), BRACKETED_PASTE_END])
  })
})
