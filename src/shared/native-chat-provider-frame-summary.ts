import type { NativeChatBlock } from './native-chat-types'

type ProviderFrameTextBlock = Extract<NativeChatBlock, { type: 'text' }>

export function nativeChatProviderFrameSummary(block: ProviderFrameTextBlock): string {
  const frame = block.providerFrame
  if (!frame) {
    return block.text
  }
  return block.text === `${frame.provider} · ${frame.kind}` ? frame.kind : block.text
}

/**
 * An unrecognised provider event stored with no words of its own: the host's fallback label is
 * its only text. Kept in the journal for readers of the frame (the Codex task list), never drawn.
 * A failure or notice (any tone) and a request Orca already answered stay visible.
 */
export function isWordlessProviderFrameBlock(block: NativeChatBlock): boolean {
  if (block.type !== 'text' || !block.providerFrame) {
    return false
  }
  const frame = block.providerFrame
  return (
    block.tone === undefined &&
    block.presentation === undefined &&
    block.failure === undefined &&
    !frame.kind.startsWith('request:') &&
    block.text === `${frame.provider} · ${frame.kind}`
  )
}
