// The composer's one primary button. A held queue's Resume, or the queue's coming send, takes
// Send's place only while nothing is typed or attached, so a typed message always offers Send.

export type NativeChatComposerPrimaryAction = 'stop' | 'resume' | 'send'

/** While no turn runs, what the queue makes an empty composer's primary button: Resume over a held
 *  queue, or Stop while the queue is about to send its next card. */
export type NativeChatQueuePrimary =
  | { kind: 'resume'; resume: () => void; resuming: boolean }
  | { kind: 'sending' }

export function nativeChatComposerPrimaryAction(input: {
  isWorking: boolean
  composerEmpty: boolean
  /** 'held': the host holds a card Resume would send. 'sending': the queue is about to send a
   *  card, so the Stop that send will need shows already. */
  queue: 'held' | 'sending' | null
}): NativeChatComposerPrimaryAction {
  if (input.isWorking) {
    return 'stop'
  }
  if (!input.composerEmpty || input.queue === null) {
    return 'send'
  }
  return input.queue === 'held' ? 'resume' : 'stop'
}

/** The button as rendered: its action, whether it is disabled, and Resume's handler when it is
 *  Resume. A Stop shown for the queue's coming send has nothing to stop until that turn starts. */
export function nativeChatComposerPrimaryButton(input: {
  isWorking: boolean
  composerEmpty: boolean
  queue: NativeChatQueuePrimary | undefined
  /** The composer cannot send at all. */
  composerDisabled: boolean
  /** Send's, or a running turn's Stop's, own disabled state. */
  sendDisabled: boolean
}): { action: NativeChatComposerPrimaryAction; disabled: boolean; resume?: () => void } {
  const { queue } = input
  const action = nativeChatComposerPrimaryAction({
    isWorking: input.isWorking,
    composerEmpty: input.composerEmpty,
    queue: queue ? (queue.kind === 'resume' ? 'held' : 'sending') : null
  })
  if (action === 'resume' && queue?.kind === 'resume') {
    return { action, disabled: input.composerDisabled || queue.resuming, resume: queue.resume }
  }
  return { action, disabled: action === 'stop' && !input.isWorking ? true : input.sendDisabled }
}
