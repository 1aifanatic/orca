import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildPtyIpcSpawnOptions } from './spawn-options'
import { launchFilePromptForPane } from '../../../agent-hooks/launch-file-prompt-by-pane'
import { createPtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

const LAUNCH_FILE = {
  placeholder: `orca-launch-file-${'a'.repeat(32)}`,
  content: 'the whole task',
  sensitive: false
}

async function spawnOptionsFor(
  args: PtySpawnIpcArgs,
  typedCommand: string | undefined,
  paneKey?: string
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: buildPtyIpcSpawnOptions only reads the members stubbed here; the rest belong to later spawn stages this test never runs.
  const deps = {
    transitionSpawnHiddenRendererPtyDeliveryState: vi.fn(),
    syncPtyBackgroundedDelivery: vi.fn(),
    sendPtySpawnedToRenderer: vi.fn(),
    getSettings: () => getDefaultSettings('/tmp'),
    runtime: { registerPreAllocatedHandleForPty: vi.fn() }
  } as unknown as PtySpawnIpcDeps
  const ctx = createPtyIpcSpawnState(deps, args)
  ctx.env = {}
  ctx.launchCommand = typedCommand
  ctx.reservationPaneKey = paneKey ?? null
  await buildPtyIpcSpawnOptions(ctx)
  return ctx.spawnOptions
}

describe('renderer pty spawn: launch file', () => {
  const command = `claude 'The full task is in the file "${LAUNCH_FILE.placeholder}".'`

  it('hands the provider the launch file its command names', async () => {
    const options = await spawnOptionsFor(
      { cols: 80, rows: 24, command, launchFile: LAUNCH_FILE },
      command
    )
    expect(options.launchFile).toEqual(LAUNCH_FILE)
  })

  it('drops a launch file whose placeholder Orca did not mint', async () => {
    const options = await spawnOptionsFor(
      { cols: 80, rows: 24, command, launchFile: { ...LAUNCH_FILE, placeholder: '../../etc' } },
      command
    )
    expect(options.launchFile).toBeUndefined()
  })

  it('drops the launch file when main types a different line, such as a resume', async () => {
    const options = await spawnOptionsFor(
      { cols: 80, rows: 24, command, launchFile: LAUNCH_FILE },
      'codex resume abc'
    )
    expect(options.launchFile).toBeUndefined()
  })

  // Why: the agent's hook reports only the pointer, so the first-work rename reads this instead.
  it('keeps the prompt a launch file carries for its pane, never a sensitive one', async () => {
    await spawnOptionsFor(
      { cols: 80, rows: 24, command, launchFile: LAUNCH_FILE },
      command,
      'tab-a:leaf-a'
    )
    await spawnOptionsFor(
      {
        cols: 80,
        rows: 24,
        command,
        launchFile: { ...LAUNCH_FILE, content: 'dcap brief', sensitive: true }
      },
      command,
      'tab-b:leaf-b'
    )
    expect(launchFilePromptForPane('tab-a:leaf-a')).toBe('the whole task')
    expect(launchFilePromptForPane('tab-b:leaf-b')).toBeUndefined()
  })
})
