import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'

export function hasInlineWorktreeAgentRows(args: {
  cardProperties: readonly WorktreeCardProperty[]
  newCardStyle: boolean
  compactCards: boolean
}): boolean {
  return args.cardProperties.includes('inline-agents') && (args.newCardStyle || !args.compactCards)
}

export function getWorktreeCardSurfacePadding(hasSecondaryContent: boolean): string {
  return hasSecondaryContent ? 'pt-1.25 pb-1.5' : 'py-2'
}
