import { describe, expect, it } from 'vitest'
import { buildHeadlessAutomationWorkspaceName } from './automation-workspace-create'

describe('automation run workspace timestamps', () => {
  it.each([
    ['Asia/Kolkata', '2026-11-02T03:30:00Z', '20261102T0900+0530'],
    ['Asia/Kathmandu', '2026-11-02T20:30:00Z', '20261103T0215+0545'],
    ['America/New_York', '2026-03-08T06:59:00Z', '20260308T0159-0500'],
    ['America/New_York', '2026-03-08T07:00:00Z', '20260308T0300-0400']
  ])('uses %s at %s', (timezone, scheduledFor, stamp) => {
    expect(
      buildHeadlessAutomationWorkspaceName('Weekly pulse run 1', Date.parse(scheduledFor), timezone)
    ).toBe(`auto-weekly-pulse-run-1-${stamp}`)
  })

  it('distinguishes both occurrences of a repeated hour after the title is truncated', () => {
    const title = 'weekly-automation-with-a-long-title-for-the-sidebar'
    expect(
      buildHeadlessAutomationWorkspaceName(
        title,
        Date.parse('2026-11-01T05:30Z'),
        'America/New_York'
      )
    ).toMatch(/20261101T0130-0400$/)
    expect(
      buildHeadlessAutomationWorkspaceName(
        title,
        Date.parse('2026-11-01T06:30Z'),
        'America/New_York'
      )
    ).toMatch(/20261101T0130-0500$/)
  })

  it('uses the host clock for an unsupported stored timezone', () => {
    const instant = Date.UTC(2026, 0, 2, 3, 4)
    expect(buildHeadlessAutomationWorkspaceName('run', instant, 'Invalid/Zone')).toBe(
      buildHeadlessAutomationWorkspaceName('run', instant)
    )
  })
})
