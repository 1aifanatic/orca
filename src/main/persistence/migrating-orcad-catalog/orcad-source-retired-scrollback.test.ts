import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  getTerminalScrollbackSnapshotPath,
  makeTerminalScrollbackSnapshotRef,
  type TerminalScrollbackSnapshotStorage
} from '../../terminal-scrollback-snapshots'
import { OrcadSourceRetirementPersistence } from './orcad-source-retirement'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function snapshotFile(ref: string, storage: TerminalScrollbackSnapshotStorage): string {
  const path = getTerminalScrollbackSnapshotPath(ref, storage)!
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'scrollback')
  return path
}

function sessionNaming(ref: string): WorkspaceSessionState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deletion reads only terminal layouts.
  return {
    terminalLayoutsByTabId: { tab: { scrollbackRefsByLeafId: { leaf: ref } } }
  } as unknown as WorkspaceSessionState
}

describe('deleting a retired migration scrollback', () => {
  it('deletes only refs no session partition or pending export still names', () => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-retired-scrollback-'))
    roots.push(root)
    const storage = { snapshotRoot: join(root, 'terminal-scrollback') }
    const [retired, inSession, inExport] = ['a', 'b', 'c'].map((tab) =>
      makeTerminalScrollbackSnapshotRef(tab, 'leaf')
    )
    const paths = [retired!, inSession!, inExport!].map((ref) => snapshotFile(ref, storage))
    const persistence = new OrcadSourceRetirementPersistence(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deletion reads only sessions, storage and export holds.
      {
        state: {
          workspaceSession: sessionNaming('v1-unrelated'),
          workspaceSessionsByHostId: { 'ssh:box': sessionNaming(inSession!) }
        },
        terminalScrollbackSnapshotStorage: storage,
        retainedScrollbackRefsByMigrationId: new Map([['other', new Set([inExport!])]])
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: repo lifecycle is unused by the deletion.
      {} as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: write scheduling is unused by the deletion.
      {} as never
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deletion reads only the manifest's snapshot list.
    const manifest = {
      payload: {
        dormantState: {
          terminalScrollbackSnapshots: [retired, inSession, inExport].map((ref) => ({ ref }))
        }
      }
    } as unknown as OrcadMigrationManifest

    persistence.deleteRetiredOrcadMigrationScrollback(manifest)

    expect(paths.map((path) => existsSync(path))).toEqual([false, true, true])
  })
})
