import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mulberry32 } from '../../../shared/agent-tui-ansi-fuzz-stream'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { projectTerminalTopologySlice } from '../../runtime/terminal-topology-projection'
import type { TerminalSurfaceCloseTarget } from '../../../shared/terminal-surface-close-target'
import { leafIds, WindowSession, withoutLeaf } from './terminal-topology-window-session-fixture'
import { checkWorkspaceLayoutRules, type WorkspaceLayoutPartition } from './workspace-layout-rules'
import { closeLeafOrTab } from './terminal-topology-commit'
import {
  emptyTerminalSessionProfile,
  FIXTURE_FOLDER_WORKTREE_ID,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore,
  reopenTopologyStore
} from './terminal-topology-profile-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

/**
 * Model test for terminal layout as main holds it. Seeded gesture sequences run against main's
 * real Store, written the way today's desktop window writes them; a plain reference model says
 * what main must hold after each one. Making the window a mirror of main changes who writes, not
 * this outcome, so every seed must stay green through that refactor.
 * Replay one seed: FUZZ_SEED=<n> FUZZ_ITERATIONS=1 pnpm test <this file>.
 */

const WORKTREES = [
  FIXTURE_GIT_WORKTREE_ID,
  FIXTURE_FOLDER_WORKTREE_ID,
  FLOATING_TERMINAL_WORKTREE_ID
]
const FIRST_SEED = Number(process.env.FUZZ_SEED ?? 0x9417)
const ITERATIONS = Number(process.env.FUZZ_ITERATIONS ?? 6)
const OPS_PER_SEED = 40

type ModelPane = { ptyId: string | undefined; sleeping: boolean }
/** What main must hold: tab → leaf → binding, per worktree, in tab order. */
type Model = Map<string, { worktreeId: string; leaves: Map<string, ModelPane> }>

const directories: string[] = []

function makeIds(random: () => number) {
  const hex = (length: number): string =>
    Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join('')
  return {
    leaf: () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`,
    tab: () => `tab-${hex(8)}`,
    pty: (worktreeId: string) => `${worktreeId}@@${hex(8)}`
  }
}

function sleepingRecord(
  worktreeId: string,
  tabId: string,
  leafId: string
): SleepingAgentSessionRecord {
  return {
    paneKey: `${tabId}:${leafId}`,
    tabId,
    worktreeId,
    agent: 'codex',
    providerSession: { key: 'session_id', id: `session-${leafId}` },
    prompt: 'model',
    state: 'waiting',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'quit'
  }
}

/** Fails on any structural breach in main's layout, or an id that changed since the last step. */
function expectLayoutRules(
  session: WorkspaceSessionState,
  previous: WorkspaceSessionState | null,
  context: string
): void {
  const partition = (state: WorkspaceSessionState): WorkspaceLayoutPartition[] => [
    { hostId: LOCAL_EXECUTION_HOST_ID, session: state }
  ]
  const violations = checkWorkspaceLayoutRules(
    partition(session),
    previous ? partition(previous) : undefined
  )
  expect(violations, context).toEqual([])
}

/** Main's projected slices, reduced to what the model states. */
function projectedTopology(session: WorkspaceSessionState) {
  return Object.fromEntries(
    WORKTREES.map((worktreeId) => {
      const slice = projectTerminalTopologySlice(session, LOCAL_EXECUTION_HOST_ID, worktreeId)
      const tabs = slice.tabs.map((tab) => {
        const layout = slice.layouts[tab.id]
        return {
          tabId: tab.id,
          leaves: Object.fromEntries(
            leafIds(layout?.root).map((leafId) => [leafId, layout?.ptyIdsByLeafId?.[leafId]])
          )
        }
      })
      return [worktreeId, { tabs, sleeping: Object.keys(slice.sleeping).sort() }]
    })
  )
}

function expectedTopology(model: Model) {
  return Object.fromEntries(
    WORKTREES.map((worktreeId) => {
      const entries = [...model.entries()].filter(([, tab]) => tab.worktreeId === worktreeId)
      const tabs = entries.map(([tabId, tab]) => ({
        tabId,
        leaves: Object.fromEntries([...tab.leaves].map(([leafId, pane]) => [leafId, pane.ptyId]))
      }))
      const sleeping = entries
        .flatMap(([tabId, tab]) =>
          [...tab.leaves]
            .filter(([, pane]) => pane.sleeping)
            .map(([leafId]) => `${tabId}:${leafId}`)
        )
        .sort()
      return [worktreeId, { tabs, sleeping }]
    })
  )
}

type Op =
  | 'new_tab'
  | 'split'
  | 'close_pane'
  | 'close_tab'
  | 'move_pane'
  | 'pty_exit'
  | 'respawn'
  | 'sleep'
  | 'wake'
  | 'restart'
  | 'quit_restart'

const OPS: readonly Op[] = [
  'new_tab',
  'new_tab',
  'split',
  'split',
  'close_pane',
  'close_tab',
  'move_pane',
  'pty_exit',
  'respawn',
  'sleep',
  'wake',
  'restart',
  'quit_restart'
]

async function runSeed(seed: number): Promise<string[]> {
  const random = mulberry32(seed)
  const pick = <T>(items: readonly T[]): T | undefined =>
    items.length === 0 ? undefined : items[Math.floor(random() * items.length)]
  const ids = makeIds(random)
  const directory = mkdtempSync(join(tmpdir(), 'orca-topology-model-'))
  directories.push(directory)
  let store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = new WindowSession(structuredClone(store.getWorkspaceSession()))
  const model: Model = new Map()
  const log: string[] = []
  let previous: WorkspaceSessionState | null = null
  const save = (): void => store.setWorkspaceSession(window.snapshot())
  const panes = () =>
    [...model].flatMap(([tabId, tab]) =>
      [...tab.leaves].map(([leafId, pane]) => ({ tabId, leafId, tab, pane }))
    )
  const splitTabs = () => [...model].filter(([, tab]) => tab.leaves.size > 1)

  const bind = async (worktreeId: string, tabId: string, leafId: string, ptyId: string) => {
    await expect(store.persistPtyBinding({ worktreeId, tabId, leafId, ptyId })).resolves.toBe(true)
    window.bind(tabId, leafId, ptyId)
    model.get(tabId)!.leaves.set(leafId, { ptyId, sleeping: false })
  }

  /** `closeTerminalSurfaceFromRenderer`: the window removed the surface; main commits the close. */
  const commitClose = async (worktreeId: string, target: TerminalSurfaceCloseTarget) => {
    const refusal = await store.runDurableMutation(
      closeLeafOrTab({
        worktreeId,
        target,
        options: { allowMissing: true, force: true, closedByLayoutOwner: true, reason: 'user' },
        requestedSession: store.getWorkspaceSession(),
        ownerMatches: () => true,
        hostId: () => LOCAL_EXECUTION_HOST_ID,
        getSession: (hostId) => store.getWorkspaceSession(hostId),
        setSession: (session, hostId) => store.setWorkspaceSession(session, hostId),
        onClosed: () => {}
      })
    )
    expect(refusal).toBeUndefined()
  }

  const reopen = async (stageQuit: boolean): Promise<void> => {
    if (stageQuit) {
      store.stageWorkspaceSessionBeforeUnload(window.snapshot())
    }
    store = await reopenTopologyStore(store, directory)
    window.session = structuredClone(store.getWorkspaceSession())
  }

  for (let step = 0; step < OPS_PER_SEED; step++) {
    const op = pick(OPS)!
    switch (op) {
      case 'new_tab': {
        const worktreeId = pick(WORKTREES)!
        const tabId = ids.tab()
        const leafId = ids.leaf()
        const ptyId = ids.pty(worktreeId)
        // pty:spawn can beat the window's debounced layout save.
        const spawnFirst = random() < 0.5
        log.push(
          `${op} ${worktreeId} ${tabId}:${leafId} ${ptyId}${spawnFirst ? ' spawn-first' : ''}`
        )
        model.set(tabId, { worktreeId, leaves: new Map() })
        window.addTab(worktreeId, tabId, leafId)
        if (!spawnFirst) {
          save()
        }
        await bind(worktreeId, tabId, leafId, ptyId)
        save()
        break
      }
      case 'split': {
        const target = pick(panes())
        if (!target) {
          continue
        }
        const leafId = ids.leaf()
        const ptyId = ids.pty(target.tab.worktreeId)
        const spawnFirst = random() < 0.5
        const direction = random() < 0.5 ? 'vertical' : 'horizontal'
        log.push(
          `${op} ${target.tabId}:${target.leafId} → ${leafId} ${ptyId}${spawnFirst ? ' spawn-first' : ''}`
        )
        const layout = window.session.terminalLayoutsByTabId[target.tabId]!
        window.setLayout(
          target.tabId,
          {
            type: 'split',
            direction,
            first: layout.root!,
            second: { type: 'leaf', leafId }
          },
          layout.ptyIdsByLeafId ?? {}
        )
        if (!spawnFirst) {
          save()
        }
        await bind(target.tab.worktreeId, target.tabId, leafId, ptyId)
        save()
        break
      }
      case 'close_pane': {
        const [tabId, tab] = pick(splitTabs()) ?? []
        const leafId = tab && pick([...tab.leaves.keys()])
        if (!tabId || !tab || !leafId) {
          continue
        }
        log.push(`${op} ${tabId}:${leafId}`)
        const layout = window.session.terminalLayoutsByTabId[tabId]!
        const { [leafId]: _closed, ...bindings } = layout.ptyIdsByLeafId ?? {}
        void _closed
        window.setLayout(tabId, withoutLeaf(layout.root!, leafId)!, bindings)
        const { [`${tabId}:${leafId}`]: _record, ...sleeping } =
          window.session.sleepingAgentSessionsByPaneKey ?? {}
        void _record
        window.setSleeping(sleeping)
        tab.leaves.delete(leafId)
        await commitClose(tab.worktreeId, { kind: 'pane', tabId, leafId })
        save()
        break
      }
      case 'close_tab': {
        const tabId = pick([...model.keys()])
        if (!tabId) {
          continue
        }
        log.push(`${op} ${tabId}`)
        const { worktreeId } = model.get(tabId)!
        window.removeTab(tabId)
        model.delete(tabId)
        await commitClose(worktreeId, { kind: 'tab', tabId })
        save()
        break
      }
      case 'move_pane': {
        const [sourceTabId, source] = pick(splitTabs()) ?? []
        const leafId = source && pick([...source.leaves.keys()])
        if (!sourceTabId || !source || !leafId) {
          continue
        }
        const targetTabId = ids.tab()
        const pane = source.leaves.get(leafId)!
        log.push(`${op} ${sourceTabId}:${leafId} → ${targetTabId}`)
        await expect(
          store.moveTerminalLeafToNewTab({
            worktreeId: source.worktreeId,
            sourceTabId,
            targetTabId,
            leafId,
            ptyId: pane.ptyId ?? null
          })
        ).resolves.toEqual({ status: 'moved', ptyId: pane.ptyId ?? null })
        // The window then shows what main moved, as the drag-out does today.
        const layout = window.session.terminalLayoutsByTabId[sourceTabId]!
        const { [leafId]: movedPty, ...bindings } = layout.ptyIdsByLeafId ?? {}
        window.setLayout(sourceTabId, withoutLeaf(layout.root!, leafId)!, bindings)
        window.addTab(source.worktreeId, targetTabId, leafId)
        if (movedPty) {
          window.bind(targetTabId, leafId, movedPty)
        }
        const records = { ...window.session.sleepingAgentSessionsByPaneKey }
        const record = records[`${sourceTabId}:${leafId}`]
        if (record) {
          delete records[`${sourceTabId}:${leafId}`]
          records[`${targetTabId}:${leafId}`] = {
            ...record,
            paneKey: `${targetTabId}:${leafId}`,
            tabId: targetTabId
          }
          window.setSleeping(records)
        }
        source.leaves.delete(leafId)
        model.set(targetTabId, {
          worktreeId: source.worktreeId,
          leaves: new Map([[leafId, pane]])
        })
        save()
        break
      }
      case 'pty_exit': {
        const target = pick(panes().filter(({ pane }) => pane.ptyId))
        if (!target) {
          continue
        }
        log.push(`${op} ${target.tabId}:${target.leafId}`)
        // Main keeps an exited pane's binding; only the window's live id goes.
        window.setTabPtyId(target.tabId, null)
        save()
        break
      }
      case 'respawn': {
        const target = pick(panes())
        if (!target) {
          continue
        }
        const ptyId = ids.pty(target.tab.worktreeId)
        log.push(`${op} ${target.tabId}:${target.leafId} ${ptyId}`)
        const sleeping = target.pane.sleeping
        await bind(target.tab.worktreeId, target.tabId, target.leafId, ptyId)
        target.tab.leaves.get(target.leafId)!.sleeping = sleeping
        save()
        break
      }
      case 'sleep':
      case 'wake': {
        const target = pick(panes().filter(({ pane }) => pane.sleeping === (op === 'wake')))
        if (!target) {
          continue
        }
        log.push(`${op} ${target.tabId}:${target.leafId}`)
        const paneKey = `${target.tabId}:${target.leafId}`
        const records = { ...window.session.sleepingAgentSessionsByPaneKey }
        if (op === 'sleep') {
          records[paneKey] = sleepingRecord(target.tab.worktreeId, target.tabId, target.leafId)
        } else {
          delete records[paneKey]
        }
        window.setSleeping(records)
        target.pane.sleeping = op === 'sleep'
        save()
        break
      }
      case 'restart':
      case 'quit_restart': {
        log.push(op)
        await reopen(op === 'quit_restart')
        break
      }
    }
    const context = `seed ${seed}, step ${step}:\n${log.join('\n')}`
    const session = store.getWorkspaceSession()
    expectLayoutRules(session, previous, context)
    previous = structuredClone(session)
    expect(projectedTopology(session), context).toEqual(expectedTopology(model))
  }

  // The saved profile, read back cold, holds the same layout.
  await reopen(false)
  const context = `seed ${seed}, after reopen:\n${log.join('\n')}`
  expectLayoutRules(store.getWorkspaceSession(), previous, context)
  expect(projectedTopology(store.getWorkspaceSession()), context).toEqual(expectedTopology(model))
  await store.freezeWritesAsync()
  return log
}

describe('terminal layout model (main session)', () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps one tab per pane, one pane per terminal, and the expected layout across random gestures', async () => {
    const ranOps = new Set<string>()
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const log = await runSeed(FIRST_SEED + iteration)
      for (const entry of log) {
        ranOps.add(entry.split(' ')[0]!)
      }
    }
    // Precondition: the seeds reached every gesture, so a green run is not a quiet one.
    if (ITERATIONS >= 6) {
      expect([...ranOps].sort()).toEqual([...new Set(OPS)].sort())
    }
  }, 60_000)
})
