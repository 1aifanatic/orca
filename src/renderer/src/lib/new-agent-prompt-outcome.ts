export type NewAgentPromptOutcome = { delivered: boolean }

/** Settles once a new agent's prompt reached its host, or did not: a start that failed puts the
 *  text in the new chat's composer instead. */
export function newAgentPromptOutcome(args: {
  delivery: Promise<{ delivered: boolean }>
}): Promise<NewAgentPromptOutcome> {
  return args.delivery.then(
    (result) => ({ delivered: result.delivered }),
    () => ({ delivered: false })
  )
}
