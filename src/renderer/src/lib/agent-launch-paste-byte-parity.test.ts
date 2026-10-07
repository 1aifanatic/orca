import { describe, expect, it } from 'vitest'
import { iterateAgentDraftPasteContentChunks } from './agent-draft-paste-content'
import { wrapTerminalBracketedPasteText } from '../../../shared/terminal-bracketed-paste-text'

// The host writes a launch prompt as one frame (`sendTerminalAgentPrompt`, inputKind `launch`); the
// window wrote the same prompt in chunks. The agent must read the same bytes either way.
describe('the host’s launch paste and the window’s paste, byte for byte', () => {
  it.each([
    ['plain text', 'fix the failing checks'],
    ['CRLF and lone CR line endings', 'line one\r\nline two\rline three\n'],
    ['an ESC that must not start a key sequence', 'before\x1b[201~after'],
    ['text beyond the BMP', 'résumé 🚀 文字'],
    ['a prompt the window splits into chunks', `${'x'.repeat(70 * 1024)}\nend`]
  ])('%s', (_label, text) => {
    expect([...iterateAgentDraftPasteContentChunks(text)].join('')).toBe(
      wrapTerminalBracketedPasteText(text)
    )
  })
})
