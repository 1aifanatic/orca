import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent
} from '../../shared/browser-client-host-protocol'
import type { RuntimeBrowserClientPlacement } from '../../shared/runtime-browser-placement'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { adoptRuntimeBrowserClientPagesFromInventory } from './runtime-browser-client-page-adoption'

const RUNTIME_ID = 'runtime-a'
const EPOCH = 'epoch-a'
const HOST_CLIENT_ID = 'host-a'
const WORKSPACE_ID = 'workspace-a'
const EXECUTION_HOST_KEY = 'native:runtime-a:1'

function leaseInput(connectionId: string, pageInventory?: BrowserClientHostedPageInventory[]) {
  return {
    browserHostClientId: HOST_CLIENT_ID,
    connectionId,
    pairedDeviceId: 'device-a',
    hostCapabilities: ['webview'],
    pageCommandProtocolVersion: 1 as const,
    pageInventoryProtocolVersion: 1 as const,
    pageInventory: pageInventory ?? [],
    pageReconciliationProtocolVersion: 1 as const,
    leaseReconnectProtocolVersion: 1 as const
  }
}

function keptInventory(
  placement: RuntimeBrowserClientPlacement,
  overrides: Partial<BrowserClientHostedPageInventory> = {}
): BrowserClientHostedPageInventory {
  return {
    authorityRuntimeId: RUNTIME_ID,
    authorityEpoch: EPOCH,
    browserHostClientId: placement.browserHostClientId,
    browserHostGeneration: placement.browserHostGeneration,
    browserPageId: 'page-a',
    pageHostGeneration: placement.pageHostGeneration,
    browserProfileId: 'default',
    executionHostKey: EXECUTION_HOST_KEY,
    state: 'active',
    currentUrl: 'https://remote.internal/kept',
    workspaceId: WORKSPACE_ID,
    ...overrides
  }
}

/**
 * A desktop placed page-a under its first lease, then the runtime fenced that lease while the two
 * could not reach each other. The runtime kept the page record; the desktop kept the guest.
 */
function fencedDesktop() {
  const leases = new BrowserHostLeaseRegistry({
    authorityRuntimeId: RUNTIME_ID,
    authorityEpoch: EPOCH
  })
  const pages = new RuntimeBrowserPageRegistry()
  const first = leases.attach(leaseInput('connection-1'))
  const placement = leases.placeClientPage('page-a', HOST_CLIENT_ID)
  if (placement.kind !== 'client') {
    throw new Error('expected a client placement')
  }
  pages.publishClientPage({
    browserPageId: 'page-a',
    workspaceId: WORKSPACE_ID,
    browserProfileId: 'default',
    executionHostKey: EXECUTION_HOST_KEY,
    placement,
    url: 'https://remote.internal/kept',
    loading: false,
    active: true
  })
  first.release()
  expect(leases.getPlacement('page-a')).toBeUndefined()
  return { leases, pages, placement }
}

function returnDesktop(
  rig: ReturnType<typeof fencedDesktop>,
  pageInventory: BrowserClientHostedPageInventory[],
  returningHostReclaim = true
) {
  const host = rig.leases.attach(leaseInput('connection-2', pageInventory))
  const identity = {
    authorityEpoch: host.lease.authorityEpoch,
    browserHostClientId: host.lease.browserHostClientId,
    browserHostGeneration: host.lease.browserHostGeneration,
    pairedDeviceId: host.lease.pairedDeviceId
  }
  const commands: BrowserClientHostCommandEvent[] = []
  rig.leases.attachCommandDelivery(identity, (event) => {
    commands.push(event)
    queueMicrotask(() => {
      rig.leases.settleClientPageCommand(
        { ...identity, connectionId: 'connection-2' },
        { ...event, result: { status: 'completed' } }
      )
    })
  })
  const notifyWorkspace = vi.fn()
  return {
    host,
    commands,
    notifyWorkspace,
    adopt: () =>
      adoptRuntimeBrowserClientPagesFromInventory({
        lease: host.lease,
        authority: rig.leases,
        pages: rig.pages,
        notifyWorkspace,
        resolveExecutionHostKey: async () => ({
          status: 'resolved',
          executionHostKey: EXECUTION_HOST_KEY
        }),
        returningHostReclaim
      })
  }
}

describe('a desktop returning after its lease was fenced', () => {
  it('gets its kept guest rekeyed onto the new lease instead of recreated', async () => {
    const rig = fencedDesktop()
    const returning = returnDesktop(rig, [keptInventory(rig.placement)])

    const result = await returning.adopt()

    expect(result.adoptedPageIds).toEqual(['page-a'])
    expect(returning.commands.map((event) => event.command.type)).toEqual(['reclaimPage'])
    expect(returning.commands[0]).toMatchObject({
      browserHostGeneration: returning.host.lease.browserHostGeneration,
      command: {
        previousAuthority: {
          authorityEpoch: EPOCH,
          browserHostGeneration: rig.placement.browserHostGeneration,
          pageHostGeneration: rig.placement.pageHostGeneration
        }
      }
    })
    const placed = rig.leases.getPlacement('page-a')
    expect(placed).toMatchObject({
      kind: 'client',
      browserHostGeneration: returning.host.lease.browserHostGeneration
    })
    // The record follows the new placement; the tab, its URL and its workspace stay as they were.
    expect(rig.pages.getPage('page-a')).toMatchObject({
      placement: placed,
      url: 'https://remote.internal/kept',
      workspaceId: WORKSPACE_ID
    })
    expect(returning.notifyWorkspace).toHaveBeenCalledWith(WORKSPACE_ID)
  })

  it('closes a kept guest whose page was closed here while the desktop was away', async () => {
    const rig = fencedDesktop()
    rig.pages.retirePage('page-a', rig.placement)
    const returning = returnDesktop(rig, [keptInventory(rig.placement)])

    await returning.adopt()

    expect(returning.commands.map((event) => event.command.type)).toEqual(['closePage'])
    expect(rig.leases.getPlacement('page-a')).toBeUndefined()
  })

  it('reloads a kept guest the desktop could not vouch for', async () => {
    const rig = fencedDesktop()
    const returning = returnDesktop(rig, [
      keptInventory(rig.placement, { state: 'outcomeUnknown' })
    ])

    const result = await returning.adopt()

    expect(returning.commands.map((event) => event.command.type)).toEqual([
      'closePage',
      'restorePage'
    ])
    expect(result.adoptedPageIds).toEqual(['page-a'])
  })

  it('places reclaimed pages above every generation this runtime already issued', async () => {
    const rig = fencedDesktop()
    rig.leases.placeServerPage('page-later')
    const returning = returnDesktop(rig, [keptInventory(rig.placement)])
    const nextGeneration = rig.leases.nextPageHostGeneration()

    await returning.adopt()

    expect(rig.leases.getPlacement('page-a')).toMatchObject({
      pageHostGeneration: nextGeneration
    })
  })

  it('leaves everything alone for a desktop that did not negotiate it', async () => {
    const rig = fencedDesktop()
    const returning = returnDesktop(rig, [keptInventory(rig.placement)], false)

    const result = await returning.adopt()

    expect(result.adoptedPageIds).toEqual([])
    expect(returning.commands).toEqual([])
    expect(rig.pages.getPage('page-a')?.placement).toEqual(rig.placement)
  })

  it('never speaks for a kept guest that names another runtime or a newer lease', async () => {
    const rig = fencedDesktop()
    const returning = returnDesktop(rig, [
      keptInventory(rig.placement, { browserPageId: 'other-epoch', authorityEpoch: 'epoch-b' }),
      keptInventory(rig.placement, { browserPageId: 'current-lease', browserHostGeneration: 99 })
    ])

    await returning.adopt()

    expect(returning.commands).toEqual([])
  })
})
