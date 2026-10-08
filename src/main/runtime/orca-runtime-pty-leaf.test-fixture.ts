import { OrcaRuntimeService } from './orca-runtime'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

/** A runtime whose single tab leaf is bound to `ptyId`, so onPtyData updates PTY and leaf tails. */
export function runtimeWithLeaf(ptyId: string): { runtime: OrcaRuntimeService; leaf: unknown } {
  const runtime = new OrcaRuntimeService()
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [{ tabId: 'tab-1', worktreeId: 'wt-1', activeLeafId: LEAF_ID, layout: null, title: '' }],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId,
        paneTitle: null
      }
    ]
  })
  const leaves: unknown = Reflect.get(runtime, 'leaves')
  if (!(leaves instanceof Map) || leaves.size !== 1) {
    throw new Error('Expected exactly one runtime leaf')
  }
  return { runtime, leaf: leaves.values().next().value }
}

export function readPtyTail(runtime: OrcaRuntimeService, ptyId: string): string[] {
  const ptys: unknown = Reflect.get(runtime, 'ptysById')
  const pty: unknown = ptys instanceof Map ? ptys.get(ptyId) : undefined
  const lines: unknown = pty && typeof pty === 'object' ? Reflect.get(pty, 'tailBuffer') : undefined
  if (!Array.isArray(lines)) {
    throw new Error('PTY record has no tail')
  }
  return lines.map(String)
}
