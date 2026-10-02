import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchHostIsPaired } from './launch-file-host'
import { buildQuickComposerStartup } from '@/hooks/composer-state/quick-startup-plan'

describe('whether a launch lands on a paired host', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is false for this machine and true for another Orca or a web client', () => {
    expect(launchHostIsPaired(null)).toBe(false)
    expect(launchHostIsPaired('env-1')).toBe(true)
    vi.stubGlobal('window', { __ORCA_WEB_CLIENT__: true })
    expect(launchHostIsPaired(null)).toBe(true)
  })
})

describe('the quick composer on a paired host', () => {
  it('sends no pointer to a paired host and leaves the prompt for the renderer to paste', () => {
    const startup = buildQuickComposerStartup({
      agent: 'claude',
      prompt: 'fix the build\nthen run the tests',
      draftPrompt: null,
      settings: null,
      repoConnectionId: null,
      platform: 'linux',
      shell: null,
      isRemote: false,
      host: { paired: true, provesAgentInFront: true },
      telemetrySource: 'sidebar'
    })
    expect(startup.backendStartup).toBeUndefined()
    expect(startup.startupPlan?.launchFile).toBeUndefined()
    expect(startup.startupPlan?.pastePromptAfterReady).toBe('fix the build\nthen run the tests')
  })
})
