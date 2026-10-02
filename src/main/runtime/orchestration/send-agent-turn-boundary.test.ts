import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanSourceTree, stripComments } from '../../../shared/source-scan/source-tree-scan'

/**
 * Orca sends a message into an agent on another agent's behalf through `sendAgentTurn` only, so
 * there is one place where queue-or-now, and later the sender, are decided. Paths are relative to
 * `src/main`.
 */
const MAIN_ROOT = resolve(__dirname, '..', '..')
const shipped = scanSourceTree(MAIN_ROOT).map((file) => ({
  ...file,
  code: stripComments(file.source)
}))

function filesMatching(pattern: RegExp): string[] {
  return shipped
    .filter((file) => pattern.test(file.code))
    .map((file) => file.relativePath)
    .sort()
}

describe('agent turn send boundary', () => {
  it('routes every agent-to-agent send through sendAgentTurn', () => {
    expect(filesMatching(/\bsendAgentTurn\s*\(/)).toEqual(
      [
        'runtime/orchestration/send-agent-turn.ts',
        // The structured mail-pointer lane.
        'runtime/orchestration/structured-mailbox-pointer-host.ts',
        // Dispatch preambles: structured worker, PTY worker, `dispatch --inject`, the
        // coordinator loop, and a federated worker host.
        'runtime/rpc/methods/orchestration-structured-worker-session.ts',
        'runtime/rpc/methods/orchestration/worker/deliver-worker-dispatch-preamble.ts',
        'runtime/rpc/methods/orchestration/runs/dispatch-methods.ts',
        'runtime/orchestration/coordinator-task-dispatch.ts',
        'runtime/rpc/methods/orchestration/federation/federation.ts'
      ].sort()
    )
  })

  it('types an agent prompt into a terminal only from sendAgentTurn or a user-facing command', () => {
    expect(
      filesMatching(/\.sendTerminalAgentPrompt\s*\(/),
      'A new direct sendTerminalAgentPrompt call. Send an agent message through sendAgentTurn.'
    ).toEqual(
      [
        // `agent.launch`: the prompt a user starts an agent with.
        'runtime/rpc/methods/agent-launch-terminal-prompt.ts',
        // `terminal.send`: an explicit write to a named terminal.
        'runtime/rpc/methods/terminal/terminal-send-method.ts',
        'runtime/orchestration/send-agent-turn.ts'
      ].sort()
    )
  })

  it('waits for a structured send to settle only in sendAgentTurn or the host itself', () => {
    expect(
      filesMatching(/\.waitForSendSettlement\s*\(/),
      'A new send-then-wait block. Send an agent message through sendAgentTurn.'
    ).toEqual(
      [
        // A /compact command, not a message.
        'native-chat/agent-session-wire/structured-conversation-compaction.ts',
        // Orca's own restart continuation, which waits for hand-over and settlement separately.
        'native-chat/agent-session-wire/structured-agent-session-restart-resume-wiring.ts',
        'runtime/orchestration/send-agent-turn.ts',
        // The composer's RPC, which waits only for clients that predate pending replies.
        'runtime/rpc/methods/structured-agent-session-send-compatibility.ts'
      ].sort()
    )
  })
})
