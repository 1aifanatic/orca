import { sendAgentDraftPasteContentToWriter } from '../../shared/agent-draft-paste-content'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS } from '../../shared/agent-prompt-injection'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'

/** Called inside the runtime's existing PTY transaction, with a fenced writer for every byte. */
export async function writeDesktopNewTabPrompt(args: {
  text: string
  agent: TuiAgent | null | undefined
  submit: boolean
  write: (data: string) => Promise<boolean>
  delay: (ms: number) => Promise<void>
}): Promise<{ submits: number }> {
  if (!(await sendAgentDraftPasteContentToWriter(args.text, args.write))) {
    throw new Error('terminal_not_writable')
  }
  if (!args.submit) {
    return { submits: 0 }
  }
  await args.delay(AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS)
  const submitted = await args.write('\r')
  let retries = 0
  const retryDelayMs = args.agent ? TUI_AGENT_CONFIG[args.agent].submitRetryDelayMs : undefined
  if (retryDelayMs !== undefined) {
    try {
      await args.delay(retryDelayMs)
      retries = (await args.write('\r')) ? 1 : 0
    } catch {
      // The retry cannot downgrade the first Enter's result.
    }
  }
  if (!submitted) {
    throw new Error('terminal_not_writable')
  }
  return { submits: 1 + retries }
}
