import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_STORAGE_KEY } from './web-storage'

const runtimeMock = vi.hoisted(() => ({
  reply: {} as Record<string, unknown>,
  environment: null as { id: string } | null
}))

vi.mock('./web-runtime-calls', () => ({
  callRuntimeResult: vi.fn(async () => ({ settings: runtimeMock.reply }))
}))
vi.mock('./web-runtime-session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireActiveEnvironmentOrNull: () => runtimeMock.environment
}))

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value)
  }
}

// The web client keeps its own settings in localStorage; blobs saved before the permission mode
// was typed carry the flag inside each agent's arguments.
describe('web stored settings agent permissions', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: memoryStorage() })
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh)' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lifts a stored legacy profile into the typed mode once and saves it', async () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        agentDefaultArgs: {
          claude: '--model opus',
          codex: '--dangerously-bypass-approvals-and-sandbox -m o3'
        }
      })
    )
    const { getStoredSettings } = await import('./web-preferences-store')

    const settings = getStoredSettings()

    expect(settings.agentPermissionMode).toBe('bypass')
    expect(settings.agentPermissionModeOverrides).toMatchObject({ claude: 'ask' })
    expect(settings.agentDefaultArgs?.claude).toBe('--model opus')
    expect(settings.agentDefaultArgs?.codex).toBe('-m o3')
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')
    expect(saved.agentPermissionMode).toBe('bypass')
    expect(getStoredSettings()).toEqual(settings)
  })

  it('gives a fresh client the Yolo default', async () => {
    const { getStoredSettings } = await import('./web-preferences-store')

    const settings = getStoredSettings()

    expect(settings.agentPermissionMode).toBe('bypass')
    expect(settings.agentDefaultArgs).toEqual({})
  })

  // The host replies to settings.update with its own launch-ready args (flag inline).
  it('keeps its own agent launch settings when merging a paired host reply', async () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ agentDefaultArgs: { claude: '--model opus' } })
    )
    runtimeMock.environment = { id: 'env-1' }
    runtimeMock.reply = {
      compactWorktreeCards: true,
      agentDefaultArgs: { claude: '--dangerously-skip-permissions --model opus', codex: '' }
    }
    const { getStoredSettings, syncRuntimeBackedSettings } = await import('./web-preferences-store')

    const next = await syncRuntimeBackedSettings(
      { compactWorktreeCards: true },
      getStoredSettings()
    )

    expect(next.compactWorktreeCards).toBe(true)
    expect(next.agentDefaultArgs?.claude).toBe('--model opus')
    expect(next.agentPermissionModeOverrides).toMatchObject({ claude: 'ask' })
    expect(next.agentPermissionModeOverrides?.codex).toBeUndefined()
    runtimeMock.environment = null
  })
})
