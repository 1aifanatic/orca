import { describe, expect, it } from 'vitest'
import {
  normalizeNotificationSettings,
  persistedNotificationSettingsRepaired
} from './onboarding-normalization'
import { getDefaultNotificationSettings } from '../../../shared/notification-settings-defaults'

describe('muted notification machines', () => {
  it('keeps valid machine ids once and drops anything else', () => {
    const normalized = normalizeNotificationSettings({
      mutedExecutionHostIds: ['runtime:m4air', 'ssh:openclaw', 'runtime:m4air', 'nope', 42, 'local']
    })
    expect(normalized.mutedExecutionHostIds).toEqual(['runtime:m4air', 'ssh:openclaw', 'local'])
  })

  it('defaults a missing or malformed list to no muted machines', () => {
    expect(normalizeNotificationSettings({}).mutedExecutionHostIds).toEqual([])
    expect(
      normalizeNotificationSettings({ mutedExecutionHostIds: 'runtime:m4air' })
        .mutedExecutionHostIds
    ).toEqual([])
  })

  it('does not count an unchanged list as a repair', () => {
    // Why: a fresh array never equals the stored one by reference; a false repair rewrites settings on every launch.
    const persisted = {
      ...getDefaultNotificationSettings(),
      mutedExecutionHostIds: ['runtime:m4air']
    }
    const normalized = normalizeNotificationSettings(persisted)
    expect(persistedNotificationSettingsRepaired(persisted, normalized)).toBe(false)
  })

  it('counts a dropped entry as a repair', () => {
    const persisted = { ...getDefaultNotificationSettings(), mutedExecutionHostIds: ['nope'] }
    const normalized = normalizeNotificationSettings(persisted)
    expect(persistedNotificationSettingsRepaired(persisted, normalized)).toBe(true)
  })
})
