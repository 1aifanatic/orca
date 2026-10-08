import { z } from 'zod'

/**
 * A server workspace's strip as its paired desktop shows it: the server's tabs, plus the editor
 * tabs only the desktop's window holds, placed where the desktop shows them (`desktopTabOrder`).
 * Pure and owner-blind on the wire: which tab came from the desktop stays in this phone's memory.
 */

const TabSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  parentTabId: z.string().optional(),
  browserWorkspaceId: z.string().optional(),
  filePath: z.string().optional()
})

const GroupSchema = z.looseObject({
  tabOrder: z.array(z.string()),
  desktopTabOrder: z.array(z.string()).optional()
})

const SnapshotSchema = z.looseObject({
  publicationEpoch: z.string().optional(),
  snapshotVersion: z.number(),
  tabs: z.array(TabSchema),
  activeTabId: z.string().nullable(),
  activeTabType: z.string().nullable(),
  tabGroups: z.array(GroupSchema).optional()
})

type Tab = z.infer<typeof TabSchema>

// Why only editors: a browser page the desktop runs is not yet streamed to phones (follow-up).
const DESKTOP_OWNED_TAB_TYPES = new Set(['file', 'markdown'])

export type ComposedSessionTabs = {
  result: unknown
  /** The ids of tabs whose actions belong to the desktop. */
  desktopTabIds: ReadonlySet<string>
}

export function composeDesktopOwnedSessionTabs(
  serverResult: unknown,
  desktopResult: unknown
): ComposedSessionTabs {
  const server = SnapshotSchema.safeParse(serverResult)
  const desktop = SnapshotSchema.safeParse(desktopResult)
  if (!server.success || !desktop.success) {
    return { result: serverResult, desktopTabIds: new Set() }
  }
  const desktopTabs = desktop.data.tabs.filter((tab) => DESKTOP_OWNED_TAB_TYPES.has(tab.type))
  const desktopFiles = new Set(desktopTabs.map((tab) => tab.filePath))
  // Why: the desktop mirrors an editor tab the server persisted, so it is listed once, as the desktop's.
  const serverTabs = server.data.tabs.filter(
    (tab) => !DESKTOP_OWNED_TAB_TYPES.has(tab.type) || !desktopFiles.has(tab.filePath)
  )
  const tabs = placeDesktopTabs(serverTabs, desktopTabs, desktopStripOrder(desktop.data))
  const desktopTabIds = new Set(desktopTabs.map((tab) => tab.id))
  // Why: selection is per device on each host; the server's pick wins unless it has none to give.
  const serverHasActive = serverTabs.some((tab) => tab.id === server.data.activeTabId)
  const desktopActive = serverHasActive
    ? null
    : (desktopTabs.find((tab) => tab.id === desktop.data.activeTabId) ?? null)
  return {
    result: {
      ...server.data,
      // Why: one publisher per pair, so a change on either side reads as newer to the phone's gate.
      publicationEpoch: `${server.data.publicationEpoch ?? ''}|desktop:${desktop.data.publicationEpoch ?? ''}`,
      snapshotVersion: server.data.snapshotVersion + desktop.data.snapshotVersion,
      tabs: tabs.map((tab) =>
        desktopTabIds.has(tab.id) ? { ...tab, isActive: tab.id === desktopActive?.id } : tab
      ),
      ...(desktopActive ? { activeTabId: desktopActive.id, activeTabType: desktopActive.type } : {})
    },
    desktopTabIds
  }
}

function desktopStripOrder(desktop: z.infer<typeof SnapshotSchema>): string[] {
  return (desktop.tabGroups ?? []).flatMap((group) => group.desktopTabOrder ?? group.tabOrder)
}

/** The strip id a server tab answers to: its tab, or the terminal or browser workspace it belongs to. */
function serverStripIds(tab: Tab): string[] {
  return [tab.id, tab.parentTabId, tab.browserWorkspaceId].filter(
    (id): id is string => id !== undefined
  )
}

/**
 * Each desktop tab goes right after the nearest server tab before it in the desktop's strip, so a
 * terminal's panes stay together; one with none before it leads, one the order omits trails.
 */
function placeDesktopTabs(serverTabs: Tab[], desktopTabs: Tab[], order: string[]): Tab[] {
  const lastServerIndexByStripId = new Map<string, number>()
  serverTabs.forEach((tab, index) => {
    for (const id of serverStripIds(tab)) {
      lastServerIndexByStripId.set(id, index)
    }
  })
  const desktopById = new Map(desktopTabs.map((tab) => [tab.id, tab]))
  const leading: Tab[] = []
  const afterServerIndex = new Map<number, Tab[]>()
  const placed = new Set<string>()
  let anchor: number | null = null
  for (const id of order) {
    const serverIndex = lastServerIndexByStripId.get(id)
    if (serverIndex !== undefined) {
      anchor = serverIndex
      continue
    }
    const desktopTab = desktopById.get(id)
    if (!desktopTab || placed.has(id)) {
      continue
    }
    placed.add(id)
    if (anchor === null) {
      leading.push(desktopTab)
    } else {
      afterServerIndex.set(anchor, [...(afterServerIndex.get(anchor) ?? []), desktopTab])
    }
  }
  const trailing = desktopTabs.filter((tab) => !placed.has(tab.id))
  return [
    ...leading,
    ...serverTabs.flatMap((tab, index) => [tab, ...(afterServerIndex.get(index) ?? [])]),
    ...trailing
  ]
}
