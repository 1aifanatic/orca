/**
 * Phone paired with a desktop that is itself a client of an `orca serve` host: the phone reaches
 * the server's workspaces through the desktop by naming them with `executionHost: runtime:<env>`.
 * The desktop relays as the phone's own delegated device on the server.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { launchPhoneMirrorTopology } from './helpers/phone-mirror-topology'
import { openPairedSocket, type PairedMobileSocket } from './helpers/paired-mobile-client'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { decodePairingOffer } from '../../src/shared/pairing'
import { z } from 'zod'

type Frame = PairedMobileSocket['frames'][number]

const WorktreeListSchema = z.object({
  worktrees: z.array(z.looseObject({ worktreeId: z.string(), path: z.string() }))
})
const CreatedTerminalSchema = z.object({ tab: z.looseObject({ terminal: z.string().nullable() }) })
const SubscribedSchema = z.looseObject({ type: z.literal('subscribed'), streamId: z.number() })

async function reply(socket: PairedMobileSocket, id: string, timeout = 30_000): Promise<Frame> {
  let found: Frame | undefined
  await expect
    .poll(() => (found = socket.frames.find((frame) => frame.id === id)), { timeout })
    .toBeDefined()
  return found!
}

async function call<T>(
  socket: PairedMobileSocket,
  request: { id: string; method: string; params: unknown; executionHost?: string },
  schema: z.ZodType<T>
): Promise<T> {
  socket.send(request.id, request.method, request.params, request.executionHost)
  const frame = await reply(socket, request.id)
  expect(frame.ok, `${request.method}: ${JSON.stringify(frame.error)}`).toBe(true)
  return schema.parse(frame.result)
}

/** Opens a terminal on the workspace, subscribes and returns how to type into it. */
async function openTerminal(socket: PairedMobileSocket, worktreeId: string, host?: string) {
  const { tab } = await call(
    socket,
    {
      id: `create-${worktreeId}-${host ?? 'direct'}`,
      method: 'session.tabs.createTerminal',
      params: {
        worktree: `id:${worktreeId}`,
        activate: false,
        select: false,
        navigation: 'caller'
      },
      executionHost: host
    },
    CreatedTerminalSchema
  )
  const terminal = tab.terminal ?? ''
  expect(terminal, 'the server publishes the terminal it created').not.toBe('')
  const client = { id: socket.token, type: 'mobile' }
  const subscribeId = `sub-${terminal}`
  socket.send(
    subscribeId,
    'terminal.subscribe',
    {
      terminal,
      client,
      viewport: { cols: 80, rows: 24 },
      capabilities: { terminalBinaryStream: 1 }
    },
    host
  )
  let streamId = -1
  await expect
    .poll(() => {
      for (const frame of socket.frames) {
        const subscribed = SubscribedSchema.safeParse(frame.result)
        if (frame.id === subscribeId && subscribed.success) {
          streamId = subscribed.data.streamId
        }
      }
      return streamId
    })
    .toBeGreaterThan(-1)
  let sent = 0
  const send = (text: string, enter: boolean): void => {
    sent += 1
    socket.send(`in-${terminal}-${sent}`, 'terminal.send', { terminal, text, enter, client }, host)
  }
  return {
    /** Runs `echo` of an arithmetic marker, so only an executed command prints the answer. */
    runMarker: async (label: string): Promise<void> => {
      send(`echo ${label}_$((1000+7))`, true)
      await socket.waitForOutput(streamId, `${label}_1007`, 20_000)
    },
    /** Time from sending a keystroke to its echo, then clears the line. */
    keystrokeEchoMs: async (key: string): Promise<number> => {
      const startedAt = performance.now()
      send(key, false)
      await socket.waitForOutput(streamId, key, 20_000)
      const elapsed = performance.now() - startedAt
      send('\x15', false)
      return elapsed
    }
  }
}

test('phone paired with a desktop lists, opens and types into a workspace on its server', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  const serverFolder = testInfo.outputPath('server-folder')
  mkdirSync(serverFolder, { recursive: true })
  writeFileSync(path.join(serverFolder, 'README.md'), 'server workspace\n')

  const { host, desktop, phone, dispose } = await launchPhoneMirrorTopology(
    { phoneTo: 'desktop', pinnedServePort: true },
    testInfo
  )
  try {
    await host.client.call('repo.add', { path: serverFolder, kind: 'folder' })
    await new RuntimeClient(desktop.userDataDir, 5_000).call('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    // The desktop window shows the server's workspace, and names its host.
    let serverHostId = ''
    await expect
      .poll(
        async () =>
          (serverHostId = await desktop.page.evaluate(
            (folder) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .find((worktree) => worktree.path === folder)?.hostId ?? '',
            serverFolder
          )),
        { timeout: 30_000 }
      )
      .toMatch(/^runtime:/)

    const socket = await phone.openSocket()
    // Untargeted calls stay the desktop's own, exactly as an older page sees them.
    const list = { method: 'worktree.ps', params: { limit: 1_000 } }
    const local = await call(socket, { id: 'ps-local', ...list }, WorktreeListSchema)
    expect(local.worktrees.map((row) => row.path)).toContain(testRepoPath)
    expect(local.worktrees.map((row) => row.path)).not.toContain(serverFolder)

    const remote = await call(
      socket,
      { id: 'ps-server', ...list, executionHost: serverHostId },
      WorktreeListSchema
    )
    const serverRow = remote.worktrees.find((row) => row.path === serverFolder)
    expect(serverRow, 'the phone lists the server workspace through the desktop').toBeDefined()
    expect(remote.worktrees.map((row) => row.path)).not.toContain(testRepoPath)

    const relayed = await openTerminal(socket, serverRow!.worktreeId, serverHostId)
    await relayed.runMarker('MIRROR')
    const relayedMs: number[] = []
    for (let i = 0; i < 10; i += 1) {
      relayedMs.push(await relayed.keystrokeEchoMs(`rq${i}x`))
    }

    // The same echo on a socket paired straight to the server, for the cost of the extra hop.
    const direct = await openPairedSocket(decodePairingOffer(host.offer.pairingUrl))
    try {
      const directTerminal = await openTerminal(direct, serverRow!.worktreeId)
      await directTerminal.runMarker('DIRECT')
      const directMs: number[] = []
      for (let i = 0; i < 10; i += 1) {
        directMs.push(await directTerminal.keystrokeEchoMs(`dq${i}x`))
      }
      const latency = JSON.stringify({ relayedMs, directMs })
      console.log(`[mirror] keystroke echo ms ${latency}`)
      await testInfo.attach('echo-latency-ms', { body: latency, contentType: 'application/json' })
    } finally {
      direct.close()
    }

    await host.restartServeProcess({
      // The server is down: a relayed call fails as unavailable, never runs on the desktop instead.
      betweenProcesses: async () => {
        socket.send('ps-stopped', 'worktree.ps', { limit: 1_000 }, serverHostId)
        const stopped = await reply(socket, 'ps-stopped', 60_000)
        expect(stopped.ok).toBe(false)
        expect(stopped.error?.code).toBe('remote_runtime_unavailable')
      }
    })
    // Back up: the same phone socket reaches the restarted server again.
    await expect
      .poll(
        async () => {
          const id = `ps-restarted-${performance.now()}`
          socket.send(id, 'worktree.ps', { limit: 1_000 }, serverHostId)
          const frame = await reply(socket, id, 30_000)
          const listed = WorktreeListSchema.safeParse(frame.result)
          return listed.success && listed.data.worktrees.some((row) => row.path === serverFolder)
        },
        { timeout: 90_000, intervals: [2_000] }
      )
      .toBe(true)
  } finally {
    await dispose()
  }
})
