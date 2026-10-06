import type React from 'react'

import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { WorkspaceStatus, Worktree } from '../../../../shared/worktree/types'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

export type WorktreeRenameRequest = {
  worktreeId: string
  rowKey?: string
}

export type ActiveSurfaceVariant = 'primary' | 'secondary'

export type WorktreeCardProps = {
  worktree: Worktree
  repo: Repo | undefined
  isActive: boolean
  isCurrentWorktree?: boolean
  isActiveSurface?: boolean
  activeSurfaceVariant?: ActiveSurfaceVariant
  isMultiSelected?: boolean
  revealHighlight?: boolean
  revealHighlightTone?: 'default' | 'ai'
  selectedWorktrees?: readonly Worktree[]
  hideRepoBadge?: boolean
  hostContextLabel?: string
  inPinnedSection?: boolean
  activationRowKey?: string
  renameRowKey?: string
  contentIndent?: number
  flushSurface?: boolean
  lineageChildCount?: number
  lineageCollapsed?: boolean
  lineageChildren?: React.ReactNode
  lineageChildrenStyle?: React.CSSProperties
  onLineageToggle?: (event: React.MouseEvent<HTMLButtonElement>) => void
  isLineageDropTarget?: boolean
  onActivate?: () => void
  onWorktreeCardClick?: () => void
  onImmediateActivate?: (worktreeId: string, rowKey: string | undefined) => void
  onSelectionGesture?: (event: React.MouseEvent<HTMLElement>, worktree: Worktree) => boolean
  onContextMenuSelect?: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
  onAssignWorkspaceStatus?: (worktreeIds: readonly string[], status: WorkspaceStatus) => void
  onCardDragStart?: (
    event: React.DragEvent<HTMLDivElement>,
    worktreeId: string,
    draggedIds: readonly string[]
  ) => void
  onCardDragEnd?: (event: React.DragEvent<HTMLDivElement>) => void
  nativeDragEnabled?: boolean
  affiliateListMode?: boolean
  /** Passive sidebar layout without live state; caller-owned `agentRows` remain interactive. */
  readOnly?: boolean
  agentRows?: React.ReactNode
  statusPrDisplay?: WorktreeCardPrDisplay | null
}

type DefaultedWorktreeCardProp =
  | 'isActiveSurface'
  | 'activeSurfaceVariant'
  | 'isMultiSelected'
  | 'revealHighlight'
  | 'revealHighlightTone'
  | 'nativeDragEnabled'
  | 'inPinnedSection'
  | 'contentIndent'
  | 'flushSurface'
  | 'lineageChildCount'
  | 'lineageCollapsed'
  | 'isLineageDropTarget'
  | 'affiliateListMode'
  | 'readOnly'
  | 'statusPrDisplay'

export type ResolvedWorktreeCardProps = Omit<WorktreeCardProps, DefaultedWorktreeCardProp> & {
  isActiveSurface: boolean
  activeSurfaceVariant: ActiveSurfaceVariant
  isMultiSelected: boolean
  revealHighlight: boolean
  revealHighlightTone: 'default' | 'ai'
  nativeDragEnabled: boolean
  inPinnedSection: boolean
  contentIndent: number
  flushSurface: boolean
  lineageChildCount: number
  lineageCollapsed: boolean
  isLineageDropTarget: boolean
  affiliateListMode: boolean
  readOnly: boolean
  statusPrDisplay: WorktreeCardPrDisplay | null
}

// Why: allowlist presentation props so caller-supplied handlers cannot make a read-only card act.
export function toReadOnlyCardProps(props: ResolvedWorktreeCardProps): ResolvedWorktreeCardProps {
  return {
    worktree: props.worktree,
    repo: props.repo,
    hideRepoBadge: props.hideRepoBadge,
    hostContextLabel: props.hostContextLabel,
    inPinnedSection: props.inPinnedSection,
    contentIndent: props.contentIndent,
    flushSurface: props.flushSurface,
    lineageChildren: props.lineageChildren,
    lineageChildrenStyle: props.lineageChildrenStyle,
    agentRows: props.agentRows,
    isActive: false,
    isActiveSurface: false,
    activeSurfaceVariant: 'primary',
    isMultiSelected: false,
    revealHighlight: false,
    revealHighlightTone: 'default',
    nativeDragEnabled: false,
    lineageChildCount: props.lineageChildCount,
    lineageCollapsed: false,
    isLineageDropTarget: false,
    affiliateListMode: true,
    readOnly: true,
    statusPrDisplay: null
  }
}

// Why: recovery cards replace live ports and agents while keeping the sidebar's quiet status lane.
const READ_ONLY_HIDDEN_CARD_PROPERTIES = new Set<WorktreeCardProperty>(['ports', 'inline-agents'])

export function getReadOnlyCardProperties(
  cardProps: readonly WorktreeCardProperty[]
): WorktreeCardProperty[] {
  return cardProps.filter((property) => !READ_ONLY_HIDDEN_CARD_PROPERTIES.has(property))
}

export const EMPTY_WORKSPACE_PORTS = []
export const HOSTED_REVIEW_CARD_REFRESH_INTERVAL_MS = 60_000

export function shouldBeginWorktreeRename(
  request: WorktreeRenameRequest | null,
  worktreeId: string,
  rowKey: string | undefined
): boolean {
  return (
    request?.worktreeId === worktreeId &&
    (request.rowKey === undefined || request.rowKey === rowKey)
  )
}

export function formatSparseDirectoryPreview(directories: string[]): string {
  const preview = directories.slice(0, 4).join(', ')
  return directories.length <= 4 ? preview : `${preview}, +${directories.length - 4} more`
}

export function isWebClient(): boolean {
  return Boolean((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__)
}

export function getDirectoryName(folderPath: string): string {
  const normalized = folderPath.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]+/)
  return parts.at(-1) || normalized || folderPath
}
