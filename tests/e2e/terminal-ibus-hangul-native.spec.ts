import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  attachTerminalImeBoundaryEvidence,
  disposeTerminalImeBoundaryProbe,
  installTerminalImeBoundaryProbe,
  readTerminalImeBoundaryTrace,
  type TerminalImeDomEvent
} from './terminal-ime-boundary-probe'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'
import { appendImeEngagementReceipt } from './terminal-ime-engagement-receipt'

const DEFAULT_REPETITIONS = 30
const MAX_REPETITIONS = 30
const DEFAULT_KEY_DELAY_MS = 1
const MAX_KEY_DELAY_MS = 100
const NATIVE_COMMAND_TIMEOUT_MS = 10_000

test.use({
  orcaAppExtraEnv: {
    GTK_IM_MODULE: 'ibus',
    IBUS_ENABLE_SYNC_MODE: '1',
    QT_IM_MODULE: 'ibus',
    XMODIFIERS: '@im=ibus'
  }
})

function nativeRepetitions(): number {
  const parsed = Number(process.env.ORCA_E2E_NATIVE_IBUS_REPETITIONS ?? DEFAULT_REPETITIONS)
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_REPETITIONS)
    : DEFAULT_REPETITIONS
}

function nativeKeyDelayMs(): number {
  const parsed = Number(process.env.ORCA_E2E_NATIVE_IBUS_KEY_DELAY_MS ?? DEFAULT_KEY_DELAY_MS)
  return Number.isInteger(parsed) && parsed >= 0
    ? Math.min(parsed, MAX_KEY_DELAY_MS)
    : DEFAULT_KEY_DELAY_MS
}

function runXdotool(...args: string[]): void {
  execFileSync('xdotool', args, { stdio: 'pipe', timeout: NATIVE_COMMAND_TIMEOUT_MS })
}

async function focusNativeTerminalWindow(page: Page): Promise<string> {
  await focusActiveTerminalInput(page)
  const title = `ORCA_NATIVE_IBUS_${randomUUID()}`
  await page.evaluate((nextTitle) => {
    document.title = nextTitle
  }, title)
  await expect.poll(() => page.title(), { timeout: 5_000 }).toBe(title)

  runXdotool('search', '--onlyvisible', '--name', title, 'windowfocus', '--sync')
  execFileSync('ibus', ['engine', 'hangul'], {
    stdio: 'pipe',
    timeout: NATIVE_COMMAND_TIMEOUT_MS
  })
  const engine = execFileSync('ibus', ['engine'], {
    encoding: 'utf8',
    timeout: NATIVE_COMMAND_TIMEOUT_MS
  }).trim()
  expect(engine).toBe('hangul')
  return title
}

function typeExactByteSequence(repetitions: number): void {
  const delay = String(nativeKeyDelayMs())
  for (let index = 0; index < repetitions; index += 1) {
    runXdotool('type', '--delay', delay, '--clearmodifiers', 'gks')
    runXdotool('key', 'Hangul')
    runXdotool('type', '--delay', delay, 'abc')
    runXdotool('key', 'Hangul')
    runXdotool('type', '--delay', delay, 'rmf')
    runXdotool('key', 'Return')
  }
}

function typeSentenceSequence(repetitions: number): void {
  const delay = String(nativeKeyDelayMs())
  for (let index = 0; index < repetitions; index += 1) {
    runXdotool(
      'type',
      '--delay',
      delay,
      '--clearmodifiers',
      'xptmxmfmf gkrh dlTsmsep duwjsgl rmfjsp'
    )
    runXdotool('key', 'Return')
  }
}

async function runNativeIbusScenario(
  page: Page,
  testInfo: TestInfo,
  testRepoPath: string,
  expectedText: string,
  driveInput: (repetitions: number) => void
): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)

  const repetitions = nativeRepetitions()
  const ptyId = await waitForActivePanePtyId(page)
  const reader = createTerminalImeByteReader(testRepoPath, repetitions)
  let completed = false
  let receivedBytes: string[] = []
  try {
    await startTerminalImeByteReader(page, ptyId, reader)
    await focusNativeTerminalWindow(page)
    await installTerminalImeBoundaryProbe(page)
    driveInput(repetitions)

    receivedBytes = await waitForTerminalImeBytes(page, reader, 30_000)
    const trace = await readTerminalImeBoundaryTrace(page)
    expect(trace.dom.some((event) => event.type === 'compositionstart')).toBe(true)
    expect(
      trace.dom.some(
        (event) =>
          (event.type === 'compositionupdate' ||
            (event.type === 'input' && event.inputType === 'insertText')) &&
          /[\uac00-\ud7af]/.test(event.data ?? '')
      )
    ).toBe(true)

    const expectedBytes = Buffer.from(`${expectedText}\n`).toString('hex')
    expect(receivedBytes).toEqual(Array.from({ length: repetitions }, () => expectedBytes))

    expect(trace.onData.join('')).toBe(`${expectedText}\r`.repeat(repetitions))
    // Why after the assertions: the receipt is the runner's proof this test ran against a live
    // engine, so it must not exist for a run that reached here with the bytes wrong.
    appendImeEngagementReceipt(testInfo.title, trace)
    completed = true
  } finally {
    await attachTerminalImeBoundaryEvidence(page, testInfo, 'native-ibus-boundaries', {
      display: process.env.DISPLAY,
      expectedText,
      keyDelayMs: nativeKeyDelayMs(),
      receivedBytes,
      repetitions
    }).catch(() => undefined)
    await disposeTerminalImeBoundaryProbe(page).catch(() => undefined)
    if (!completed) {
      await sendToTerminal(page, ptyId, '\x03').catch(() => undefined)
    }
    removeTerminalImeByteReader(reader)
  }
}

test.describe('Native IBus Hangul terminal input @headful', () => {
  test.skip(
    process.env.ORCA_E2E_NATIVE_IBUS_HANGUL !== '1',
    'Run through config/scripts/run-terminal-ibus-hangul-e2e.mjs'
  )

  test('forwards the issue exact-byte sequence without loss or duplication', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runNativeIbusScenario(orcaPage, testInfo, testRepoPath, '한abc글', typeExactByteSequence)
  })

  test('forwards the issue sentence stress sequence without leaked ASCII', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runNativeIbusScenario(
      orcaPage,
      testInfo,
      testRepoPath,
      '테스트를 하고 있는데 여전히 그러네',
      typeSentenceSequence
    )
  })
})

test.describe('Native IBus Hangul workspace notes @headful', () => {
  test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })
  test.skip(
    process.env.ORCA_E2E_NATIVE_IBUS_HANGUL !== '1',
    'Run through the isolated native IBus harness'
  )

  test('confirms native Hangul notes before a deliberate Enter saves', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    expect(process.platform).toBe('linux')
    expect(process.env.GITHUB_ACTIONS).toBe('true')
    expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted')
    expect(process.env.DISPLAY).toMatch(/^:\d+(?:\.\d+)?$/)
    const windowId = await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window || window.isVisible() || process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
        throw new Error('Native Notes requires an owned background window')
      }
      return window.getNativeWindowHandle().readUInt32LE(0).toString()
    })
    // Native input is confined to the harness-owned Xvfb display on hosted CI.
    runXdotool('windowmap', '--sync', windowId)
    runXdotool('windowfocus', '--sync', windowId)
    execFileSync('ibus', ['engine', 'hangul'], { timeout: NATIVE_COMMAND_TIMEOUT_MS })
    expect(
      execFileSync('ibus', ['engine'], {
        encoding: 'utf8',
        timeout: NATIVE_COMMAND_TIMEOUT_MS
      }).trim()
    ).toBe('hangul')

    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      const worktree =
        state &&
        Object.values(state.worktreesByRepo)
          .flat()
          .find((row) => row.id === state.activeWorktreeId)
      if (!state || !worktree) {
        throw new Error('Missing owned workspace')
      }
      state.openModal('edit-meta', {
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        currentDisplayName: worktree.displayName,
        currentComment: '',
        focus: 'comment'
      })
    })
    const input = orcaPage.getByPlaceholder('Notes about this worktree...')
    await expect(input).toBeVisible()
    await input.click()
    const events = await input.evaluateHandle((element) => {
      if (!(element instanceof HTMLTextAreaElement)) {
        throw new Error('Missing Notes textarea')
      }
      const events: TerminalImeDomEvent[] = []
      for (const type of [
        'compositionstart',
        'compositionupdate',
        'compositionend',
        'input',
        'keydown',
        'keyup'
      ]) {
        element.addEventListener(type, (event) => {
          const keyboard = event instanceof KeyboardEvent ? event : null
          const inputEvent = event instanceof InputEvent ? event : null
          const composition = event instanceof CompositionEvent ? event : null
          events.push({
            type: event.type,
            data: inputEvent?.data ?? composition?.data ?? null,
            inputType: inputEvent?.inputType ?? null,
            key: keyboard?.key ?? null,
            code: keyboard?.code ?? null,
            keyCode: keyboard?.keyCode ?? null,
            isComposing: keyboard?.isComposing ?? inputEvent?.isComposing ?? null,
            selectionEnd: element.selectionEnd,
            selectionStart: element.selectionStart,
            value: element.value
          })
        })
      }
      return events
    })
    try {
      runXdotool('type', '--delay', '10', '--clearmodifiers', 'gksrmf')
      runXdotool('key', 'Return')
      await expect
        .poll(() =>
          events.evaluate((trace) =>
            trace.some((event) => event.type === 'keyup' && event.key === 'Enter')
          )
        )
        .toBe(true)
      await orcaPage.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      await expect(input).toBeVisible()
      await expect(input).toHaveValue('한글')
      const readSavedComment = () =>
        orcaPage.evaluate(() => {
          const state = window.__store?.getState()
          return (
            state &&
            Object.values(state.worktreesByRepo)
              .flat()
              .find((row) => row.id === state.activeWorktreeId)?.comment
          )
        })
      expect(await readSavedComment()).not.toBe('한글')
      await orcaPage.screenshot({
        path: testInfo.outputPath('native-confirm-keeps-notes-open.png')
      })
      runXdotool('key', 'Return')
      await expect(input).toBeHidden()
      await expect.poll(readSavedComment).toBe('한글')
      const dom = await events.jsonValue()
      expect(dom.some((event) => event.type === 'compositionstart')).toBe(true)
      expect(dom.some((event) => /[\uac00-\ud7af]/.test(event.data ?? ''))).toBe(true)
      await testInfo.attach('native-notes-dom-trace', {
        body: JSON.stringify({
          nativeOperatingSystemIme: true,
          engine: 'ibus-hangul',
          display: process.env.DISPLAY,
          onData: [],
          dom
        }),
        contentType: 'application/json'
      })
      appendImeEngagementReceipt(testInfo.title, { dom, onData: [] })
    } finally {
      await events.dispose()
    }
  })
})
