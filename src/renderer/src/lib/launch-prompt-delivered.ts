// Whether a launch's prompt reached its agent, for a caller that says "Started an AI agent" only
// then. A structured chat's first message starts its agent, so the tab existing proves nothing; a
// launch with no prompt delivery to wait on counts as started when its surface exists.

type LaunchWithPromptDelivery = {
  promptDeliveryResult?: Promise<{ delivered: boolean }>
}

export async function launchPromptDelivered(launch: LaunchWithPromptDelivery): Promise<boolean> {
  if (!launch.promptDeliveryResult) {
    return true
  }
  return launch.promptDeliveryResult.then(
    (result) => result.delivered,
    () => false
  )
}
