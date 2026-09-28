import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  appGetPathMock: vi.fn(() => '/downloads'),
  shellOpenExternalMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  menuBuildFromTemplateMock: vi.fn(),
  guestOffMock: vi.fn(),
  guestOnMock: vi.fn(),
  guestSetBackgroundThrottlingMock: vi.fn(),
  guestSetWindowOpenHandlerMock: vi.fn(),
  guestOpenDevToolsMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 })),
  openPopupWithOriginBarMock: vi.fn(),
  processUserAgentMode: 'clean',
  processUserAgent: ''
}))

vi.mock('electron', () => ({
  app: { getPath: mocks.appGetPathMock },
  BrowserWindow: { fromWebContents: mocks.browserWindowFromWebContentsMock },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: mocks.shellOpenExternalMock },
  Menu: { buildFromTemplate: mocks.menuBuildFromTemplateMock },
  screen: { getCursorScreenPoint: mocks.screenGetCursorScreenPointMock },
  webContents: { fromId: mocks.webContentsFromIdMock }
}))
vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: mocks.openPopupWithOriginBarMock
}))
vi.mock('./browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({
    mode: mocks.processUserAgentMode,
    userAgent: mocks.processUserAgent
  })
}))

import { browserManager } from './browser-manager'
import { googleAuthUserAgent } from './browser-google-auth-ua'
import { resetBrowserManagerMocks, resetBrowserManagerState } from './browser-manager-test-harness'
import {
  createViewportGuestFactory,
  flushViewportOps,
  GUEST_CLEAN_UA,
  GUEST_ELECTRON_UA,
  type ViewportGuestHandle
} from './browser-manager-viewport-test-fixtures'

const makeGuest = createViewportGuestFactory(mocks)
const guests = new Map<number, Record<string, unknown>>()
const PRESETS = {
  none: null,
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 375, height: 667, deviceScaleFactor: 2, mobile: true }
} as const
type Preset = keyof typeof PRESETS
const MODES = [
  ['clean', GUEST_CLEAN_UA],
  ['native', GUEST_ELECTRON_UA]
] as const
const ORDINARY_URL = 'https://example.com/'
const AUTH_URL = 'https://accounts.google.com/v3/signin/identifier'
const APP_TOKENS = /Electron\/|orca\//i
let nextGuestId = 7000

type Observed = {
  presented: string
  standingOverride: Record<string, unknown> | null
  requestIdentity: ReturnType<typeof browserManager.resolveBrowserGuestRequestUserAgent>
}

/** Opens a tab on `url` the way a real load does: did-start-navigation runs before any preset. */
function openTab(url: string): { tab: string; id: number; handle: ViewportGuestHandle } {
  const id = nextGuestId++
  const tab = `tab-${id}`
  const handle = makeGuest(id, url)
  guests.set(id, handle.guest)
  expect(browserManager.registerOffscreenGuest({ browserPageId: tab, webContentsId: id })).toBe(
    true
  )
  navigate(url)
  return { tab, id, handle }
}

function navigate(url: string, { inPlace = false } = {}): void {
  const didStartNavigation = mocks.guestOnMock.mock.calls.findLast(
    ([event]) => event === 'did-start-navigation'
  )?.[1]
  expect(didStartNavigation).toBeTypeOf('function')
  didStartNavigation(null, url, inPlace, true)
}

async function observe(
  { id, handle }: { id: number; handle: ViewportGuestHandle },
  url: string
): Promise<Observed> {
  await flushViewportOps()
  return {
    presented: handle.presentedUserAgent(),
    standingOverride: handle.standingUserAgentOverride(),
    requestIdentity: browserManager.resolveBrowserGuestRequestUserAgent({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads no Session member.
      session: handle.guest.session as Electron.Session,
      url,
      webContentsId: id
    })
  }
}

async function presentWith(url: string, preset: Preset): Promise<Observed> {
  const opened = openTab(url)
  const override = PRESETS[preset]
  if (override) {
    await browserManager.setViewportOverride(opened.tab, override)
  }
  return observe(opened, url)
}

// Why: Chromium drops navigator.userAgentData and every sec-ch-ua header for a UA override that
// carries no userAgentMetadata, so only Firefox (which sends no hints) may stand without it.
function expectClientHintsKept(observed: Observed): void {
  const override = observed.standingOverride
  if (override && override.userAgent !== googleAuthUserAgent()) {
    expect(override.userAgentMetadata).toBeDefined()
  }
}

describe('tab identity ownership', () => {
  beforeEach(() => {
    expect(process.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
    resetBrowserManagerMocks(mocks)
    resetBrowserManagerState()
    guests.clear()
    mocks.webContentsFromIdMock.mockImplementation((id) => guests.get(id))
  })
  afterEach(() => {
    browserManager.unregisterAll()
    vi.restoreAllMocks()
  })

  describe.each(MODES)('in %s mode', (mode, processUserAgent) => {
    beforeEach(() => {
      mocks.processUserAgentMode = mode
      mocks.processUserAgent = processUserAgent
    })

    it.each([ORDINARY_URL, AUTH_URL])(
      'presents the same identity with a desktop preset as with none on %s',
      async (url) => {
        const none = await presentWith(url, 'none')
        const desktop = await presentWith(url, 'desktop')
        expect(desktop).toEqual(none)
        expectClientHintsKept(desktop)
        const expected =
          mode === 'clean' && url === AUTH_URL ? googleAuthUserAgent() : processUserAgent
        expect(desktop.presented).toBe(expected)
        expect(desktop.requestIdentity.userAgent).toBe(expected)
        expect(desktop.requestIdentity.kind).toBe(
          expected === processUserAgent ? 'process' : 'google-auth'
        )
      }
    )

    it('presents the mobile identity with matching client hints on an ordinary host', async () => {
      const observed = await presentWith(ORDINARY_URL, 'mobile')
      expect(observed.presented).toContain('iPhone')
      expect(observed.standingOverride).toMatchObject({
        userAgentMetadata: expect.objectContaining({ mobile: true, platform: 'iOS' })
      })
      expect(observed.requestIdentity.kind).toBe('mobile')
      expect(observed.requestIdentity.userAgent).toBe(observed.presented)
    })

    it('keeps the Google sign-in identity ahead of a mobile preset only in clean mode', async () => {
      const observed = await presentWith(AUTH_URL, 'mobile')
      expectClientHintsKept(observed)
      if (mode === 'clean') {
        expect(observed.presented).toBe(googleAuthUserAgent())
        expect(observed.requestIdentity.kind).toBe('google-auth')
      } else {
        expect(observed.presented).toContain('iPhone')
        expect(observed.requestIdentity.kind).toBe('mobile')
      }
    })

    it.each(['desktop', 'none'] as const)(
      'restores the process identity when switching from mobile to %s',
      async (next) => {
        const opened = openTab(ORDINARY_URL)
        await browserManager.setViewportOverride(opened.tab, PRESETS.mobile)
        expect(opened.handle.presentedUserAgent()).toContain('iPhone')

        await browserManager.setViewportOverride(opened.tab, PRESETS[next])
        const observed = await observe(opened, ORDINARY_URL)
        expect(observed.presented).toBe(processUserAgent)
        expect(observed.standingOverride).toBeNull()
        expect(observed.requestIdentity).toEqual({ kind: 'process', userAgent: processUserAgent })
      }
    )
  })

  it('never puts the Electron or app tokens on a clean-mode tab under any preset', async () => {
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    for (const url of [ORDINARY_URL, AUTH_URL]) {
      for (const preset of ['none', 'desktop', 'mobile'] as const) {
        const observed = await presentWith(url, preset)
        expect(observed.presented).not.toMatch(APP_TOKENS)
        expect(observed.requestIdentity.userAgent).not.toMatch(APP_TOKENS)
      }
    }
  })

  // Why: Chromium rejects touch emulation with maxTouchPoints 0, so every step after it used to be
  // skipped and the mobile UA outlived its preset. Identity is no longer a step after touch.
  it('restores the process identity and reports the failure when touch emulation is rejected', async () => {
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const opened = openTab(ORDINARY_URL)
    await browserManager.setViewportOverride(opened.tab, PRESETS.mobile)
    opened.handle.debuggerSendCommand.mockImplementation(
      (method: string, params?: { maxTouchPoints?: number }) =>
        method === 'Emulation.setTouchEmulationEnabled' && params?.maxTouchPoints === 0
          ? Promise.reject(new Error('Touch points must be between 1 and 16'))
          : Promise.resolve(undefined)
    )

    await expect(browserManager.setViewportOverride(opened.tab, PRESETS.desktop)).resolves.toBe(
      false
    )
    const observed = await observe(opened, ORDINARY_URL)
    expect(observed.presented).toBe(GUEST_CLEAN_UA)
    expect(observed.standingOverride).toBeNull()
    expect(warn).toHaveBeenCalledWith(
      '[browser-manager] setViewportOverride: touch emulation failed',
      expect.objectContaining({ error: 'Touch points must be between 1 and 16' })
    )
  })

  it('still presents the requested mobile identity when device metrics fail', async () => {
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const opened = openTab(ORDINARY_URL)
    opened.handle.debuggerSendCommand.mockImplementation((method: string) =>
      method === 'Emulation.setDeviceMetricsOverride'
        ? Promise.reject(new Error('metrics failed'))
        : Promise.resolve(undefined)
    )

    await expect(browserManager.setViewportOverride(opened.tab, PRESETS.mobile)).resolves.toBe(
      false
    )
    expect((await observe(opened, ORDINARY_URL)).presented).toContain('iPhone')
  })

  it('heals a mid-redirect process override on the next navigation', async () => {
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    const opened = openTab(AUTH_URL)
    await browserManager.setViewportOverride(opened.tab, PRESETS.desktop)
    const willRedirect = mocks.guestOnMock.mock.calls.findLast(
      ([event]) => event === 'will-redirect'
    )?.[1]
    willRedirect({ preventDefault: vi.fn() }, ORDINARY_URL, false, true)
    // The WebContents UA still says Firefox, so clearing here would expose it on an ordinary host.
    expect((await observe(opened, ORDINARY_URL)).presented).toBe(GUEST_CLEAN_UA)

    navigate('https://example.org/')
    const healed = await observe(opened, 'https://example.org/')
    expect(healed.presented).toBe(GUEST_CLEAN_UA)
    expect(healed.standingOverride).toBeNull()
  })

  // Why: setUserAgent() while a document loads makes Chromium reload it, and an OAuth callback that
  // strips its code with replaceState would be requested twice — the one-time code replayed.
  it('leaves the WebContents UA alone on a same-document navigation', async () => {
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    const opened = openTab(AUTH_URL)
    const willRedirect = mocks.guestOnMock.mock.calls.findLast(
      ([event]) => event === 'will-redirect'
    )?.[1]
    willRedirect({ preventDefault: vi.fn() }, `${ORDINARY_URL}callback?code=1`, false, true)
    await flushViewportOps()

    navigate(`${ORDINARY_URL}callback`, { inPlace: true })
    expect(opened.handle.webContentsUserAgent()).toBe(googleAuthUserAgent())
    expect((await observe(opened, ORDINARY_URL)).presented).toBe(GUEST_CLEAN_UA)

    navigate('https://example.org/')
    expect(opened.handle.webContentsUserAgent()).toBe(GUEST_CLEAN_UA)
  })

  // Why: a debugger that cannot attach (DevTools open on the guest) installs no mobile identity, so
  // requests claiming one would disagree with the document's own navigator.userAgent.
  it('keeps requests on the presented identity when a mobile preset cannot attach', async () => {
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const opened = openTab(ORDINARY_URL)
    opened.handle.debuggerIsAttached.mockReturnValue(false)
    opened.handle.debuggerAttach.mockImplementation(() => {
      throw new Error('Another debugger is already attached')
    })

    await expect(browserManager.setViewportOverride(opened.tab, PRESETS.mobile)).resolves.toBe(
      false
    )
    navigate('https://example.org/')
    const observed = await observe(opened, 'https://example.org/')
    expect(observed.presented).toBe(GUEST_CLEAN_UA)
    expect(observed.requestIdentity).toEqual({ kind: 'process', userAgent: GUEST_CLEAN_UA })
  })
})
