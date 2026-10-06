import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  serializeBudgetedMobileSnapshot,
  type MobileSnapshotByteBudget
} from './terminal-snapshot-publication'
import { getOutputAfterSnapshotSeq } from './terminal-stream-replay'
import type { SerializedSnapshot, TerminalOutputChunk } from './terminal-stream-types'

type RendererScreen = NonNullable<SerializedSnapshot>

/**
 * Rebuilds the host model from a renderer screen, replaying the output after its seq, and returns
 * the model's snapshot. A hidden pane answers at its own size; the model sits on the PTY grid.
 */
export async function seedModelFromRendererScreen(
  runtime: Pick<
    OrcaRuntimeService,
    'replaceHeadlessTerminalFromRendererSnapshotForRecovery' | 'serializeTerminalBuffer'
  >,
  ptyId: string,
  screen: RendererScreen,
  pendingOutput: readonly TerminalOutputChunk[],
  snapshotByteBudget: MobileSnapshotByteBudget | undefined
): Promise<SerializedSnapshot> {
  const trailingOutput = pendingOutput.flatMap((item) => {
    const output = getOutputAfterSnapshotSeq(item, screen.seq)
    const seq = item.meta?.seq
    return output && typeof seq === 'number' ? [{ data: output.data, seq }] : []
  })
  await runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(
    ptyId,
    screen,
    trailingOutput
  )
  // Why mobile: only a phone subscribe adopts a renderer screen.
  return serializeBudgetedMobileSnapshot(runtime, ptyId, true, snapshotByteBudget)
}
