/**
 * Runs the layout checks after each scenario step and records which check fired.
 *
 * - rules: the runtime's layout breaks a structural rule (also on transient reads while settling),
 *   or an id changed for the same pane, tab or group since the previous step.
 * - view: what the window draws differs from the runtime's layout.
 * - client: what a paired client / the CLI is told differs from the runtime's layout.
 * - expected: the runtime's layout is not the one the scenario's commands should produce.
 * - restart: the layout after a relaunch (or PTY daemon restart) differs from before it.
 * - marker: text written to a pane's terminal never shows in that pane (a frozen or crossed pane).
 */

import type { Page } from '@stablyai/playwright-test'
import type { RuntimeClient } from '../../../src/cli/runtime/client'
import {
  checkWorkspaceLayoutRules,
  diffOracleLayouts,
  formatViolations,
  toOracleLayout,
  type OracleLayout,
  type WorkspaceLayoutPartition
} from './workspace-layout-oracle-model'
import { compareClientToRuntime, compareDrawnToRuntime } from './workspace-layout-oracle-compare'
import { readClientView, readDrawnLayout, type ClientView } from './workspace-layout-oracle-views'

export type OracleCheck = 'rules' | 'view' | 'client' | 'expected' | 'restart' | 'marker'
export type OracleFinding = {
  check: OracleCheck
  step: string
  details: string[]
  /** What each side held when the finding was recorded, for the report only. */
  evidence?: unknown
}

export type OracleTarget = {
  /** The window, when one is attached; a headless runtime has none. */
  page?: Page
  client: RuntimeClient
  readPartitions: () => Promise<WorkspaceLayoutPartition[]>
  /** Worktrees whose client view is compared; the scenario's own worktrees. */
  worktreeIds: () => string[]
}

/** Panes per terminal tab, in tab order, for one worktree. */
export type ExpectedLayout = { worktreeId: string; panesPerTab: number[] }

const SETTLE_TIMEOUT_MS = Number(process.env.ORCA_LAYOUT_ORACLE_SETTLE_MS ?? 12_000)
const POLL_MS = 300

type ViewRead = { view: string[]; client: string[]; evidence: Record<string, unknown> }

function summarizeClientView(view: ClientView): unknown {
  return {
    worktreeId: view.worktreeId,
    error: view.error,
    publicationEpoch: view.tabs?.publicationEpoch,
    groups: view.tabs?.tabGroups?.map((group) => [group.id, group.tabOrder]),
    panes: view.tabs?.tabs.flatMap((tab) =>
      tab.type === 'terminal' ? [[tab.parentTabId, tab.leafId, tab.ptyId ?? null, tab.title]] : []
    ),
    terminals: view.terminals.map((terminal) => [
      terminal.tabId,
      terminal.leafId,
      terminal.ptyId,
      terminal.orphaned ?? false
    ])
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function expectedDifferences(layout: OracleLayout, expected: ExpectedLayout): string[] {
  const entry = Object.entries(layout).find(([key]) => key.endsWith(`|${expected.worktreeId}`))
  const actual = entry?.[1].terminalTabs.map((tab) => tab.panes.length) ?? []
  return JSON.stringify(actual) === JSON.stringify(expected.panesPerTab)
    ? []
    : [
        `${expected.worktreeId}: panes per tab ${JSON.stringify(actual)}, expected ${JSON.stringify(expected.panesPerTab)}`
      ]
}

export class LayoutOracle {
  readonly findings: OracleFinding[] = []
  private previous: WorkspaceLayoutPartition[] | null = null
  private snapshot: OracleLayout | null = null

  constructor(private target: OracleTarget) {}

  retarget(target: OracleTarget): void {
    this.target = target
  }

  private record(check: OracleCheck, step: string, details: string[], evidence?: unknown): void {
    if (details.length > 0) {
      this.findings.push({ check, step, details: [...new Set(details)], evidence })
    }
  }

  private async readViews(partitions: WorkspaceLayoutPartition[]): Promise<ViewRead> {
    const { page, client } = this.target
    const clientViews = await Promise.all(
      this.target.worktreeIds().map((worktreeId) => readClientView(client, worktreeId))
    )
    // A pane keeps its binding after its terminal exits or sleeps; the window then draws none.
    const live = new Set(
      clientViews.flatMap((view) => view.terminals.flatMap((terminal) => terminal.ptyId ?? []))
    )
    const drawn = page ? await readDrawnLayout(page) : null
    return {
      view: drawn ? compareDrawnToRuntime(partitions, drawn, live) : [],
      client: clientViews.flatMap((view) => compareClientToRuntime(partitions, view)),
      evidence: { drawn, clients: clientViews.map(summarizeClientView) }
    }
  }

  /**
   * Waits until the runtime's layout is stable and every view agrees with it, then records what
   * still differs. Views may lag the runtime; only a difference that outlives the wait counts.
   */
  async step(label: string, expected?: ExpectedLayout): Promise<OracleLayout> {
    const transient = new Set<string>()
    const deadline = Date.now() + SETTLE_TIMEOUT_MS
    let last = ''
    let stableReads = 0
    let partitions: WorkspaceLayoutPartition[] = []
    let differences: ViewRead = { view: [], client: [], evidence: {} }
    for (;;) {
      partitions = await this.target.readPartitions()
      for (const line of formatViolations(checkWorkspaceLayoutRules(partitions))) {
        transient.add(line)
      }
      const serialized = JSON.stringify(toOracleLayout(partitions))
      stableReads = serialized === last ? stableReads + 1 : 0
      last = serialized
      differences = await this.readViews(partitions)
      const agreed = differences.view.length === 0 && differences.client.length === 0
      if ((agreed && stableReads >= 2) || Date.now() > deadline) {
        break
      }
      await sleep(POLL_MS)
    }
    const settled = formatViolations(
      checkWorkspaceLayoutRules(partitions, this.previous ?? undefined)
    )
    this.record('rules', label, settled)
    this.record(
      'rules',
      `${label} (transient)`,
      [...transient].filter((line) => !settled.includes(line))
    )
    const layout = toOracleLayout(partitions)
    const evidence = { runtime: layout, ...differences.evidence }
    this.record('view', label, differences.view, evidence)
    this.record('client', label, differences.client, evidence)
    if (expected) {
      this.record('expected', label, expectedDifferences(layout, expected), evidence)
    }
    this.previous = partitions
    return layout
  }

  /** Remember the settled layout so `compareRestart` can diff the relaunched runtime against it. */
  rememberForRestart(layout: OracleLayout): void {
    this.snapshot = layout
  }

  compareRestart(
    label: string,
    layout: OracleLayout,
    options: { maskPtyIds?: boolean } = {}
  ): void {
    if (!this.snapshot) {
      throw new Error('compareRestart called before rememberForRestart')
    }
    this.record(
      'restart',
      label,
      diffOracleLayouts(this.snapshot, layout, { ...options, label: 'after restart' })
    )
  }

  /**
   * Writes a unique marker into every bound pane the window shows and requires it to appear in
   * that pane's terminal (read from the xterm accessibility tree in the DOM). No pane is a finding.
   */
  async checkMarkers(label: string, worktreeId: string): Promise<number> {
    const { page, client } = this.target
    if (!page) {
      return 0
    }
    const listed = await client.call<{
      terminals: { handle: string; tabId: string; leafId: string }[]
    }>('terminal.list', { worktree: `id:${worktreeId}` })
    const mounted = new Set(
      await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('.pane[data-leaf-id][data-pty-id]'))
          .filter((pane) => pane.getBoundingClientRect().width > 0)
          .map((pane) => pane.dataset.leafId ?? '')
      )
    )
    const failures: string[] = []
    let checked = 0
    for (const [index, terminal] of listed.result.terminals.entries()) {
      if (!mounted.has(terminal.leafId)) {
        continue
      }
      const marker = `ORACLE_MARK_${Date.now().toString(36)}_${index}`
      await client.call('terminal.send', {
        terminal: terminal.handle,
        text: `echo ${marker}`,
        enter: true
      })
      checked += 1
      const deadline = Date.now() + 10_000
      let shown = false
      while (!shown && Date.now() < deadline) {
        shown = await page.evaluate(
          ({ leafId, text }) => {
            for (const manager of window.__paneManagers?.values() ?? []) {
              for (const pane of manager.getPanes()) {
                if (
                  manager.getLeafId(pane.id) === leafId &&
                  !pane.terminal.options.screenReaderMode
                ) {
                  pane.terminal.options.screenReaderMode = true
                  pane.terminal.refresh(0, pane.terminal.rows - 1)
                }
              }
            }
            const node = document.querySelector(
              `.pane[data-leaf-id="${CSS.escape(leafId)}"] .xterm-accessibility-tree`
            )
            return (node?.textContent ?? '').includes(text)
          },
          { leafId: terminal.leafId, text: marker }
        )
        if (!shown) {
          await sleep(POLL_MS)
        }
      }
      if (!shown) {
        failures.push(`pane ${terminal.tabId}:${terminal.leafId} never showed ${marker}`)
      }
    }
    if (checked === 0) {
      failures.push(`no visible pane of ${worktreeId} to write a marker into`)
    }
    this.record('marker', label, failures)
    return checked
  }
}
