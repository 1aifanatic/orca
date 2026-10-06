/** `delivered`: the notes' text reached the new chat, sent or waiting in its composer, so the notes
 *  let go of it. */
export type NewAgentPromptOutcome = { delivered: boolean }

/** Settles once a new agent's prompt reached its host or its composer, or did not: a start that
 *  failed puts the text in the new chat's composer instead. */
export function newAgentPromptOutcome(args: {
  delivery: Promise<{ delivered: boolean; inComposer?: true }>
}): Promise<NewAgentPromptOutcome> {
  return args.delivery.then(
    (result) => ({ delivered: result.delivered || result.inComposer === true }),
    () => ({ delivered: false })
  )
}
