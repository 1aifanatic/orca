import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import { cleanupE2EDaemons } from './helpers/electron-process-shutdown'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  navigateGuest,
  readClientBrowserRows,
  openClientHostedFixturePage,
  readClientWebviewMarker,
  selectPairedWorktreeGroup,
  startClientHostedMarkerFixture,
  waitForPairedWorktreeId,
  waitForRenderedClientWebview,
  type ClientHostedMarkerFixture,
  type MirroredBrowserPage
} from './helpers/client-hosted-browser-fixture'
import { startFreezableTcpProxy, type FreezableTcpProxy } from './helpers/freezable-tcp-proxy'
import { decodePairingOffer, encodePairingOffer } from '../../src/shared/pairing'

/**
 * Long enough for the host to void the lease. A reset outage starts the 15s lease grace at once; a
 * silent one first needs the host's heartbeat to reap the socket (three missed 15s probes).
 */
const OUTAGE_MS = { reset: 25_000, silent: 100_000 } as const
/** Past the client's own 15s reconnect grace, so the composition has parked. */
const PARKED_AFTER_MS = 20_000
const UNAVAILABLE_TITLE = 'Client-hosted browser unavailable'

type OutageRig = {
  fixture: ClientHostedMarkerFixture
  host: HeadlessPairedRuntimeHost
  client: PairedElectronClient
  proxy: FreezableTcpProxy | null
  worktreeId: string
  opened: MirroredBrowserPage
}

/**
 * Pairs a client to a headless host and opens one client-hosted fixture page. The client dials
 * through a cuttable proxy unless the test restarts the host itself.
 */
async function withOutageRig(
  testInfo: TestInfo,
  testRepoPath: string,
  options: {
    name: string
    viaProxy?: boolean
    pinnedServePort?: boolean
    hostEnv?: Record<string, string>
    clientEnv?: Record<string, string>
  },
  body: (rig: OutageRig) => Promise<void>
): Promise<void> {
  const fixture = await startClientHostedMarkerFixture({ created: 'outage-survivor', moved: 'x' })
  const host = await launchHeadlessPairedRuntimeHost({
    ...(options.pinnedServePort ? { pinnedServePort: true } : {}),
    ...(options.hostEnv ? { extraEnv: options.hostEnv } : {})
  })
  let client: PairedElectronClient | null = null
  let proxy: FreezableTcpProxy | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    let pairingUrl = host.offer.pairingUrl
    if (options.viaProxy !== false) {
      const decoded = decodePairingOffer(pairingUrl)
      if (!('endpoint' in decoded)) {
        throw new Error('expected a direct pairing offer')
      }
      const endpoint = new URL(decoded.endpoint)
      proxy = await startFreezableTcpProxy(endpoint.hostname, Number(endpoint.port))
      endpoint.port = String(proxy.port)
      pairingUrl = encodePairingOffer({ ...decoded, endpoint: endpoint.toString() })
    }
    client = await launchPairedElectronClient(
      { pairingUrl },
      testInfo,
      options.name,
      options.clientEnv ? { extraEnv: options.clientEnv } : {}
    )
    const worktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)
    const opened = await openClientHostedFixturePage(client, worktreeId, fixture.markerUrl)
    expect(
      await waitForRenderedClientWebview(
        client.page,
        { urlPrefix: fixture.markerUrl, remotePageId: opened.remotePageId },
        'client-hosted guest never rendered the fixture'
      )
    ).toBe('outage-survivor')
    await body({ fixture, host, client, proxy, worktreeId, opened })
  } finally {
    if (client) {
      await cleanupE2EDaemons(client.userDataDir).catch(() => undefined)
      await client.dispose()
    }
    await proxy?.close()
    await host.dispose()
    await fixture.close()
  }
}

async function readPageHostGeneration(
  client: PairedElectronClient,
  localPageId: string
): Promise<number | null> {
  return client.page.evaluate((pageId) => {
    const placement = window.__store?.getState().remoteBrowserPageHandlesByPageId[pageId]?.placement
    return placement?.kind === 'client' ? placement.pageHostGeneration : null
  }, localPageId)
}

/** Runs a script in this page's own guest, or null when it has no live one. */
async function evaluateInGuest(page: Page, remotePageId: string, script: string): Promise<unknown> {
  return page.evaluate(
    async ({ remotePageId, script }) => {
      const host = document.querySelector(
        `[data-browser-client-page-id="${CSS.escape(remotePageId)}"]`
      )
      for (const candidate of host?.querySelectorAll('webview') ?? []) {
        try {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: selected by the webview tag name.
          return await (candidate as Electron.WebviewTag).executeJavaScript(script)
        } catch {
          // The guest may still be attaching.
        }
      }
      return null
    },
    { remotePageId, script }
  )
}

/** Marks the live document; only the same document, never a reload, can read it back. */
async function stampGuest(rig: OutageRig): Promise<string> {
  const token = `kept-${Date.now()}`
  expect(
    await evaluateInGuest(
      rig.client.page,
      rig.opened.remotePageId,
      `window.__outageToken = ${JSON.stringify(token)}`
    )
  ).toBe(token)
  return token
}

function readGuestStamp(rig: OutageRig): Promise<unknown> {
  return evaluateInGuest(rig.client.page, rig.opened.remotePageId, 'window.__outageToken ?? null')
}

function waitForHostOfflineCopy(rig: OutageRig): Promise<void> {
  return expect(
    rig.client.page.getByText(/is offline/),
    'the tab never said its host was offline'
  ).not.toHaveCount(0, { timeout: 30_000 })
}

/** The page answers to the host again: its network goes through, and nothing says "unavailable". */
async function expectPageServing(rig: OutageRig): Promise<void> {
  await expect(rig.client.page.getByText(UNAVAILABLE_TITLE)).toHaveCount(0)
  await expect(rig.client.page.getByText(/is offline/)).toHaveCount(0, { timeout: 30_000 })
  // Retried because routes rebuild just after the lease returns; a load in that gap fails once.
  await expect
    .poll(
      async () => {
        await navigateGuest(rig.client.page, rig.fixture.origin, rig.fixture.movedUrl).catch(
          () => undefined
        )
        return readClientWebviewMarker(rig.client.page, {
          urlPrefix: rig.fixture.origin,
          remotePageId: rig.opened.remotePageId
        })
      },
      { timeout: 30_000, message: 'the page could not load anything after the host returned' }
    )
    .toBe('x')
}

async function waitForNewPlacement(rig: OutageRig, generationBefore: number | null): Promise<void> {
  await expect
    .poll(() => readPageHostGeneration(rig.client, rig.opened.localPageId), {
      timeout: 90_000,
      message: 'the same desktop never hosted its page again after the network returned'
    })
    .not.toBe(generationBefore)
}

for (const mode of ['silent', 'reset'] as const) {
  test(`the same live page survives a ${mode} network outage longer than the lease grace`, async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(420_000)
    await withOutageRig(testInfo, testRepoPath, { name: `${mode} outage` }, async (rig) => {
      const token = await stampGuest(rig)
      const hostPid = rig.host.app.process().pid
      const generationBefore = await readPageHostGeneration(rig.client, rig.opened.localPageId)
      expect(generationBefore).not.toBeNull()

      rig.proxy!.cut(mode)
      if (mode === 'reset') {
        await waitForHostOfflineCopy(rig)
      }
      await new Promise((resolve) => setTimeout(resolve, OUTAGE_MS[mode]))
      rig.proxy!.restore()

      // Why the generation: a new placement proves the host took the page back under a new lease.
      await waitForNewPlacement(rig, generationBefore)
      // Why the stamp: it survives only if the host rekeyed the kept guest instead of reloading it.
      expect(await readGuestStamp(rig), 'the page was reloaded instead of kept').toBe(token)
      await expectPageServing(rig)
      expect(rig.host.app.process().pid, 'the host must not have restarted').toBe(hostPid)
    })
  })
}

test('a short outage inside the lease grace keeps the same lease and page', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  await withOutageRig(testInfo, testRepoPath, { name: 'short outage' }, async (rig) => {
    const token = await stampGuest(rig)
    const generationBefore = await readPageHostGeneration(rig.client, rig.opened.localPageId)

    rig.proxy!.cut('reset')
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    rig.proxy!.restore()

    await expect(rig.client.page.getByText(/is offline/)).toHaveCount(0, { timeout: 30_000 })
    expect(await readPageHostGeneration(rig.client, rig.opened.localPageId)).toBe(generationBefore)
    expect(await readGuestStamp(rig)).toBe(token)
    await expectPageServing(rig)
  })
})

test('a parked page never reaches the network except through its host', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  await withOutageRig(testInfo, testRepoPath, { name: 'parked network' }, async (rig) => {
    rig.proxy!.cut('reset')
    await new Promise((resolve) => setTimeout(resolve, PARKED_AFTER_MS))
    const requestsBefore = rig.fixture.requestCount()

    const probe = await evaluateInGuest(
      rig.client.page,
      rig.opened.remotePageId,
      `fetch(${JSON.stringify(`${rig.fixture.movedUrl}?parked-probe`)}, { cache: 'no-store' })` +
        `.then((response) => 'reached:' + response.status, (error) => 'failed:' + error)`
    )

    // Why both: the fetch must fail, and the server must not have seen it by another route.
    expect(String(probe)).toMatch(/^failed:/)
    expect(rig.fixture.requestCount()).toBe(requestsBefore)
    rig.proxy!.restore()
    await expectPageServing(rig)
  })
})

test('a host that quits and stays down past the grace gets the tab back when it relaunches', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(420_000)
  await withOutageRig(
    testInfo,
    testRepoPath,
    { name: 'host offline', viaProxy: false, pinnedServePort: true },
    async (rig) => {
      await rig.host.restartServeProcess({
        betweenProcesses: async () => {
          await waitForHostOfflineCopy(rig)
          await new Promise((resolve) => setTimeout(resolve, PARKED_AFTER_MS))
          await expect(rig.client.page.getByText(UNAVAILABLE_TITLE)).toHaveCount(0)
        }
      })

      // A relaunched host is a new runtime; reloading the page at its last URL is acceptable.
      expect(
        await waitForRenderedClientWebview(
          rig.client.page,
          { urlPrefix: rig.fixture.markerUrl, remotePageId: rig.opened.remotePageId },
          'the page never came back after its host relaunched'
        )
      ).toBe('outage-survivor')
      await expectPageServing(rig)
    }
  )
})

test('an older host that cannot take back a kept page fails the outage as it always did', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  await withOutageRig(
    testInfo,
    testRepoPath,
    { name: 'older host', hostEnv: { ORCA_E2E_DISABLE_RETURNING_HOST_RECLAIM: '1' } },
    async (rig) => {
      await stampGuest(rig)

      rig.proxy!.cut('reset')
      await new Promise((resolve) => setTimeout(resolve, OUTAGE_MS.reset))
      rig.proxy!.restore()

      // No regression and no fix: nothing parks, so the guest is closed exactly as before.
      await expect
        .poll(() => readGuestStamp(rig), {
          timeout: 90_000,
          message: 'an older host must not keep the guest'
        })
        .toBeNull()
    }
  )
})

test('a long absence frees the live page but keeps the tab to reload it', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  await withOutageRig(
    testInfo,
    testRepoPath,
    {
      name: 'long absence',
      clientEnv: { ORCA_E2E_BROWSER_CLIENT_HOST_PARKED_DISCARD_MS: '10000' }
    },
    async (rig) => {
      await stampGuest(rig)
      rig.proxy!.cut('reset')
      await expect
        .poll(() => readGuestStamp(rig), {
          timeout: 60_000,
          message: 'the parked guest was never freed'
        })
        .toBeNull()
      // The guest is gone but the tab stays, and it says why instead of "unavailable".
      expect(
        (await readClientBrowserRows(rig.client.page, rig.worktreeId)).map((row) => row.pageId)
      ).toContain(rig.opened.localPageId)
      await waitForHostOfflineCopy(rig)
      await expect(rig.client.page.getByText(UNAVAILABLE_TITLE)).toHaveCount(0)

      rig.proxy!.restore()
      expect(
        await waitForRenderedClientWebview(
          rig.client.page,
          { urlPrefix: rig.fixture.markerUrl, remotePageId: rig.opened.remotePageId },
          'the freed page never came back at its last URL'
        )
      ).toBe('outage-survivor')
      await expectPageServing(rig)
    }
  )
})

test('a page closed on the host while this desktop was away is closed here when it returns', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  await withOutageRig(testInfo, testRepoPath, { name: 'closed while away' }, async (rig) => {
    rig.proxy!.cut('reset')
    await new Promise((resolve) => setTimeout(resolve, OUTAGE_MS.reset))
    await rig.host.client.call('browser.tabClose', { page: rig.opened.remotePageId })
    rig.proxy!.restore()

    // The host's answer decides: its closed page leaves this desktop too, guest and row.
    await expect
      .poll(() => countGuests(rig), {
        timeout: 90_000,
        message: 'the closed page kept a live guest on this desktop'
      })
      .toBe(0)
    await expect
      .poll(
        async () =>
          (await readClientBrowserRows(rig.client.page, rig.worktreeId)).some(
            (row) => row.pageId === rig.opened.localPageId
          ),
        { timeout: 60_000, message: 'the closed page kept its row on this desktop' }
      )
      .toBe(false)
  })
})

/** Live guests for this page anywhere in the window, mounted or not. */
async function countGuests(rig: OutageRig): Promise<number> {
  return rig.client.app.evaluate(({ webContents }, url) => {
    return webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === 'webview' && contents.getURL().startsWith(url))
      .length
  }, rig.fixture.markerUrl)
}
