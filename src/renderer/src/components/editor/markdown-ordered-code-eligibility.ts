import { createTiptapMarkedFacade } from './tiptap-marked-facade'

const CODE_FIRST_ITEM =
  /^(?:[ \t]*(?:>|[-+*](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*\d{1,9}[.)][ \t]+(?:`{3,}|~{3,})/m
const FENCE = /^[ ]{0,3}(?:`{3,}|~{3,})/
const PARSE_LIMIT = 50_000

export function hasUnsafeOrderedCodeFirstItem(content: string): boolean {
  if (!CODE_FIRST_ITEM.test(content)) {
    return false
  }
  // The rich parser drops first-block list fences; oversized candidates cannot be proved safe here.
  if (content.length > PARSE_LIMIT) {
    return true
  }
  try {
    const marked = createTiptapMarkedFacade()
    let unsafe = false
    marked.walkTokens(marked.lexer(content), (token) => {
      if (token.type === 'list' && token.ordered) {
        unsafe ||= token.items.some((item) => {
          const first = item.tokens.find((child) => child.type !== 'space')
          return first?.type === 'code' && FENCE.test(first.raw)
        })
      }
    })
    return unsafe
  } catch {
    return true
  }
}
