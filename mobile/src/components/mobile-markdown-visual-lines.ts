import {
  NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE,
  parseNativeChatVisualDirectiveLine,
  type NativeChatVisualDirective
} from '../../../src/shared/native-chat-visual-directive'

/** Same fence shapes the block parser opens and closes on, so a directive inside code stays code. */
const CODE_FENCE_OPEN = /^```([A-Za-z0-9_-]+)?\s*$/
const CODE_FENCE_CLOSE = /^```\s*$/
const PLACEHOLDER = /^ORCA_VISUAL_(\d+)$/

export type MobileMarkdownVisualLines = {
  /** The content with each recognized directive line replaced by a placeholder line. */
  text: string
  directives: NativeChatVisualDirective[]
}

function placeholderFor(index: number): string {
  return `ORCA_VISUAL_${index}`
}

/**
 * Lifts native-chat visual directive lines out of assistant prose before preview normalization,
 * which decodes entities and strips tags and would otherwise rewrite a title. Only top-level lines
 * outside fenced code count; quotes and list items never start with the marker. Past the per-message
 * cap a directive stays literal text.
 */
export function protectMobileMarkdownVisualLines(content: string): MobileMarkdownVisualLines {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const directives: NativeChatVisualDirective[] = []
  let inFence = false
  const next = lines.map((line) => {
    if (inFence) {
      inFence = !CODE_FENCE_CLOSE.test(line)
      return line
    }
    if (CODE_FENCE_OPEN.test(line)) {
      inFence = true
      return line
    }
    if (directives.length >= NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE) {
      return line
    }
    const directive = parseNativeChatVisualDirectiveLine(line)
    if (!directive) {
      return line
    }
    directives.push(directive)
    // Blank lines around it make the directive its own block, splitting any paragraph it was in.
    return `\n${placeholderFor(directives.length - 1)}\n`
  })
  return { text: next.join('\n'), directives }
}

/** The directive index a parsed line stands for, or null for any other line. */
export function mobileMarkdownVisualPlaceholderIndex(line: string, count: number): number | null {
  const match = PLACEHOLDER.exec(line.trim())
  if (!match) {
    return null
  }
  const index = Number(match[1])
  return index < count ? index : null
}
