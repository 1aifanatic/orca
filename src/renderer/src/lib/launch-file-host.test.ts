import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchHostWritesLaunchFile } from './launch-file-host'
import { buildQuickComposerStartup } from '@/hooks/composer-state/quick-startup-plan'

describe('whether a launch host writes its launch file', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is true for this machine and false for a paired host or a web client', () => {
    expect(launchHostWritesLaunchFile({ activeRuntimeEnvironmentId: null })).toBe(true)
    expect(launchHostWritesLaunchFile({ activeRuntimeEnvironmentId: 'env-1' })).toBe(false)
    vi.stubGlobal('window', { __ORCA_WEB_CLIENT__: true })
    expect(launchHostWritesLaunchFile({ activeRuntimeEnvironmentId: null })).toBe(false)
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
      platform: 'win32',
      shell: 'powershell',
      isRemote: false,
      hostWritesLaunchFile: false,
      telemetrySource: 'sidebar'
    })
    expect(startup.backendStartup).toBeUndefined()
    expect(startup.startupPlan?.launchFile).toBeUndefined()
    expect(startup.startupPlan?.followupPrompt).toBe('fix the build\nthen run the tests')
  })
})
