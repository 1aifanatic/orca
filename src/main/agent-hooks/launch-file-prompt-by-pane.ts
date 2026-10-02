import type { LaunchFile } from '../../shared/launch-prompt-file'

// Why bounded: an entry outlives its launch until newer ones push it out; the rename reads only a
// prompt's opening, and a pane's rename runs within minutes of its launch.
const KEPT_PANES = 50
const KEPT_CHARS = 4_000
const promptByPane = new Map<string, string>()

/**
 * Keeps a launch file's prompt for the pane it launched, for the first-work rename: the agent's hook
 * reports only the pointer to the file. A sensitive file (a worker brief with its capability) is
 * never kept.
 */
export function rememberLaunchFilePrompt(
  paneKey: string,
  launchFile: LaunchFile | undefined
): void {
  if (!launchFile || launchFile.sensitive) {
    return
  }
  promptByPane.delete(paneKey)
  promptByPane.set(paneKey, launchFile.content.slice(0, KEPT_CHARS))
  for (const oldest of promptByPane.keys()) {
    if (promptByPane.size <= KEPT_PANES) {
      break
    }
    promptByPane.delete(oldest)
  }
}

export function launchFilePromptForPane(paneKey: string): string | undefined {
  return promptByPane.get(paneKey)
}
