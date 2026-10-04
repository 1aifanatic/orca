// The composer's one primary button. A held queue's Resume takes Send's place only while nothing
// is typed or attached, so a typed message always offers Send.

export type NativeChatComposerPrimaryAction = 'stop' | 'resume' | 'send'

export function nativeChatComposerPrimaryAction(input: {
  isWorking: boolean
  composerEmpty: boolean
  /** The host holds a queued card that Resume would send. */
  queueHeld: boolean
}): NativeChatComposerPrimaryAction {
  if (input.isWorking) {
    return 'stop'
  }
  return input.composerEmpty && input.queueHeld ? 'resume' : 'send'
}
