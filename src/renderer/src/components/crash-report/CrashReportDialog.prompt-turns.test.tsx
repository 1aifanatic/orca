// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import type { CrashReportRecord } from '../../../../shared/crash-reporting'
import { CrashReportDialog } from './CrashReportDialog'
import { SshPassphraseDialog } from '../settings/SshPassphraseDialog'
import { TooltipProvider } from '../ui/tooltip'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn()
  })
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement

const pendingCrash: CrashReportRecord = {
  id: 'crash-1',
  createdAt: '2026-10-05T00:00:00.000Z',
  status: 'pending',
  source: 'renderer',
  processType: 'renderer',
  reason: 'crashed',
  exitCode: 5,
  appVersion: '1.0.0',
  platform: 'darwin',
  osRelease: 'test',
  arch: 'arm64',
  electronVersion: '1',
  chromeVersion: '1',
  details: {}
}

let openCrashReportFromMenu: () => void = () => {}
let resolveSubmit: (value: unknown) => void = () => {}
const crashReports = {
  getLatestPending: vi.fn(async (): Promise<CrashReportRecord | null> => pendingCrash),
  getLatestReport: vi.fn(async (): Promise<CrashReportRecord | null> => null),
  dismiss: vi.fn(async () => undefined),
  submit: vi.fn(
    () =>
      new Promise((resolve) => {
        resolveSubmit = resolve
      })
  )
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function crashOnScreen(): boolean {
  return document.body.textContent?.includes('Send Report') === true
}

function sshOnScreen(): boolean {
  return [...document.querySelectorAll('[role="dialog"]')].some((dialog) =>
    dialog.textContent?.includes('SSH Key Passphrase')
  )
}

function notes(): string {
  return document.querySelector<HTMLTextAreaElement>('textarea')?.value ?? ''
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.trim().endsWith(label)
  )
  if (!found) {
    throw new Error(`Missing button: ${label}`)
  }
  return found
}

function typeNotes(text: string): void {
  const area = document.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!area || !setter) {
    throw new Error('Missing notes field')
  }
  act(() => {
    setter.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  crashReports.submit.mockClear()
  crashReports.dismiss.mockClear()
  crashReports.getLatestReport.mockReset().mockResolvedValue(null)
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ settings: getDefaultSettings('') })
  useAppStore.getState().settleLaunchPromptDiscovery()
  Object.assign(window, {
    api: {
      crashReports,
      ui: {
        onOpenCrashReport: (cb: () => void) => {
          openCrashReportFromMenu = cb
          return () => {}
        }
      },
      ssh: { submitCredential: vi.fn(async () => undefined) },
      gh: { viewer: vi.fn(async () => null) }
    }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function mountBoth({ waitForCrash = true } = {}): Promise<void> {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <CrashReportDialog />
        <SshPassphraseDialog />
      </TooltipProvider>
    )
  )
  await flush()
  if (waitForCrash) {
    await vi.waitFor(() => expect(crashOnScreen()).toBe(true), { timeout: 5000 })
  }
}

function raiseSsh(): void {
  act(() => {
    useAppStore.getState().enqueueSshCredentialRequest({
      requestId: 'r1',
      targetId: 't1',
      kind: 'passphrase',
      detail: '~/.ssh/id_ed25519'
    })
  })
}

it('an SSH prompt stacks over the launch crash report, which keeps its notes throughout', async () => {
  await mountBoth()
  typeNotes('it crashed when I opened the diff')
  const area = document.querySelector('textarea')
  raiseSsh()
  await flush()
  expect(sshOnScreen()).toBe(true)
  expect(document.querySelector('textarea')).toBe(area)
  expect(notes()).toBe('it crashed when I opened the diff')

  await act(async () => useAppStore.getState().removeSshCredentialRequest('r1'))
  await flush()
  expect(document.querySelector('textarea')).toBe(area)
  expect(notes()).toBe('it crashed when I opened the diff')
})

it('a report sent while an SSH prompt interrupts it is sent once and the dialog closes', async () => {
  await mountBoth()
  typeNotes('notes')
  await act(async () => button('Send Report').click())
  expect(crashReports.submit).toHaveBeenCalledTimes(1)
  raiseSsh()
  await flush()
  await act(async () => {
    resolveSubmit({ ok: true, report: { ...pendingCrash, status: 'submitted' } })
  })
  await flush()
  await act(async () => useAppStore.getState().removeSshCredentialRequest('r1'))
  await flush()
  expect(crashOnScreen()).toBe(false)
  expect(crashReports.submit).toHaveBeenCalledTimes(1)
})

it('Help > Report Crash over the launch report: closing it does not bring the same report back', async () => {
  // Same report as the launch one; the version string only marks which dialog renders it.
  crashReports.getLatestReport.mockResolvedValue({ ...pendingCrash, appVersion: '9.9.9' })
  await mountBoth()
  expect(document.body.textContent).toContain('Orca 1.0.0')
  await act(async () => openCrashReportFromMenu())
  await flush()
  await vi.waitFor(() => expect(document.body.textContent).toContain('Orca 9.9.9'))
  await act(async () => button("Don't Send").click())
  await flush()
  expect(crashOnScreen()).toBe(false)
  expect(useAppStore.getState().automaticPromptRequests).toEqual([])
})

it('Help > Report Crash over the report on screen keeps the same dialog and its notes', async () => {
  crashReports.getLatestReport.mockResolvedValue(pendingCrash)
  await mountBoth()
  typeNotes('it crashed when I opened the diff')
  await act(async () => openCrashReportFromMenu())
  await flush()
  expect(crashOnScreen()).toBe(true)
  expect(notes()).toBe('it crashed when I opened the diff')
})

it('a send in flight when Help > Report Crash opens is sent once and closes the dialog', async () => {
  crashReports.getLatestReport.mockResolvedValue(pendingCrash)
  await mountBoth()
  await act(async () => button('Send Report').click())
  await act(async () => openCrashReportFromMenu())
  await flush()
  await act(async () => {
    resolveSubmit({ ok: true, report: { ...pendingCrash, status: 'submitted' } })
  })
  await flush()
  expect(crashOnScreen()).toBe(false)
  expect(crashReports.submit).toHaveBeenCalledTimes(1)
})

const newerCrash: CrashReportRecord = {
  ...pendingCrash,
  id: 'crash-2',
  createdAt: '2026-10-05T01:00:00.000Z',
  appVersion: '9.9.9'
}

/** Real IPC answers on a later task, after React has rendered the Help click. */
function latestAfterIpc(report: CrashReportRecord | null): void {
  crashReports.getLatestReport.mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve(report), 20))
  )
}

async function openFromHelp(): Promise<void> {
  await act(async () => openCrashReportFromMenu())
  await flush()
  await vi.waitFor(() => expect(document.body.textContent).toContain('Orca 9.9.9'))
}

it('Help pressed again while its dialog is open keeps the same dialog and its notes', async () => {
  crashReports.getLatestPending.mockResolvedValueOnce(null)
  latestAfterIpc(newerCrash)
  await mountBoth({ waitForCrash: false })
  await openFromHelp()
  typeNotes('second help press')
  await openFromHelp()
  expect(notes()).toBe('second help press')
})

it('a send in flight when Help is pressed again is sent once and closes the dialog', async () => {
  crashReports.getLatestPending.mockResolvedValueOnce(null)
  latestAfterIpc(newerCrash)
  await mountBoth({ waitForCrash: false })
  await openFromHelp()
  await act(async () => button('Send Report').click())
  await openFromHelp()
  await act(async () => resolveSubmit({ ok: true, report: { ...newerCrash, status: 'submitted' } }))
  await flush()
  expect(crashOnScreen()).toBe(false)
  expect(crashReports.submit).toHaveBeenCalledTimes(1)
})

it('a send in flight when Help shows a newer report still settles the report it was for', async () => {
  latestAfterIpc(newerCrash)
  await mountBoth()
  await act(async () => button('Send Report').click())
  await openFromHelp()
  await act(async () =>
    resolveSubmit({ ok: true, report: { ...pendingCrash, status: 'submitted' } })
  )
  await flush()
  // The newer report the user is looking at stays open.
  expect(document.body.textContent).toContain('Orca 9.9.9')

  await act(async () => button("Don't Send").click())
  await flush()
  // The sent report never comes back to be sent again.
  expect(crashOnScreen()).toBe(false)
  expect(crashReports.submit).toHaveBeenCalledTimes(1)
})
