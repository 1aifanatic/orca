import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'
import { sameRuntimeBrowserPlacement } from '../../shared/runtime-browser-placement'
import type { RuntimeBrowserPlacement } from './browser-host-page-placement'
import type { BrowserHostRuntimePageIntent } from './browser-host-page-reconciliation-plan'
import type { RuntimeBrowserClientPage } from './runtime-browser-page-registry'

export type ReturningClientPageSelection = {
  /** Kept guests whose record this runtime still holds under the fenced placement. */
  reclaimable: readonly {
    page: RuntimeBrowserClientPage
    inventory: BrowserClientHostedPageInventory
  }[]
  /** Kept guests this runtime placed and has since released: closed while the desktop was away. */
  releasedPageIds: readonly string[]
}

/**
 * Sorts what a desktop that comes back after its lease was fenced still holds from THIS runtime.
 *
 * Only entries naming this process and epoch, this desktop, and an older lease qualify: anything
 * else is a restart (adoption's case) or not this desktop's. A page some lease still places is left
 * alone, since its owner, not this attach, speaks for it.
 */
export function selectReturningClientPages(input: {
  inventory: readonly BrowserClientHostedPageInventory[]
  authority: { authorityRuntimeId: string; authorityEpoch: string }
  lease: { browserHostClientId: string; browserHostGeneration: number }
  getPage(browserPageId: string): RuntimeBrowserClientPage | undefined
  getPlacement(browserPageId: string): RuntimeBrowserPlacement | undefined
}): ReturningClientPageSelection {
  const reclaimable: ReturningClientPageSelection['reclaimable'][number][] = []
  const releasedPageIds: string[] = []
  for (const inventory of input.inventory) {
    if (
      inventory.authorityRuntimeId !== input.authority.authorityRuntimeId ||
      inventory.authorityEpoch !== input.authority.authorityEpoch ||
      inventory.browserHostClientId !== input.lease.browserHostClientId ||
      inventory.browserHostGeneration >= input.lease.browserHostGeneration ||
      input.getPlacement(inventory.browserPageId)
    ) {
      continue
    }
    const page = input.getPage(inventory.browserPageId)
    if (!page) {
      releasedPageIds.push(inventory.browserPageId)
    } else if (sameRuntimeBrowserPlacement(page.placement, inventoryPlacement(inventory))) {
      reclaimable.push({ page, inventory })
    }
  }
  return { reclaimable, releasedPageIds }
}

/**
 * Intents that take each kept guest back under the new lease. `reclaimFrom` lets the plan rekey an
 * active guest in place; anything else it closes and restores at its last URL.
 *
 * Generations start above both the inventory and what this runtime has already issued, because
 * the placement registry refuses one below its high-water mark.
 */
export function buildReturningClientPageIntents(input: {
  pages: ReturningClientPageSelection['reclaimable']
  authority: { authorityRuntimeId: string; authorityEpoch: string }
  lease: { browserHostClientId: string; browserHostGeneration: number; pairedDeviceId: string }
  minimumPageHostGeneration: number
}): readonly BrowserHostRuntimePageIntent[] {
  const ordered = [...input.pages].sort(
    (left, right) => left.inventory.pageHostGeneration - right.inventory.pageHostGeneration
  )
  const baseGeneration = ordered.reduce(
    (highest, { inventory }) => Math.max(highest, inventory.pageHostGeneration),
    input.minimumPageHostGeneration - 1
  )
  return ordered.map(({ page, inventory }, index) =>
    Object.freeze({
      authorityRuntimeId: input.authority.authorityRuntimeId,
      authorityEpoch: input.authority.authorityEpoch,
      browserHostClientId: input.lease.browserHostClientId,
      browserHostGeneration: input.lease.browserHostGeneration,
      pageHostGeneration: baseGeneration + index + 1,
      browserPageId: page.browserPageId,
      browserProfileId: page.browserProfileId,
      executionHostKey: page.executionHostKey,
      workspaceId: page.workspaceId,
      reclaimFrom: Object.freeze({
        authorityRuntimeId: inventory.authorityRuntimeId,
        authorityEpoch: inventory.authorityEpoch,
        browserHostClientId: inventory.browserHostClientId,
        browserHostGeneration: inventory.browserHostGeneration,
        pageHostGeneration: inventory.pageHostGeneration,
        pairedDeviceId: input.lease.pairedDeviceId
      })
    })
  )
}

function inventoryPlacement(inventory: BrowserClientHostedPageInventory): RuntimeBrowserPlacement {
  return {
    kind: 'client',
    browserHostClientId: inventory.browserHostClientId,
    browserHostGeneration: inventory.browserHostGeneration,
    pageHostGeneration: inventory.pageHostGeneration
  }
}
