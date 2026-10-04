// A real child (plain Node, never an agent CLI) that stops talking mid-turn by closing its stdout
// while the process itself keeps running: the connection broke, nothing exited.

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  GROK_CONFIG_OPTIONS,
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello
} from './acp-structured-adapter.test-support'
import { spawnAcpStructuredChild } from './acp-structured-child'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

// Answers the handshake, echoes one reply chunk for the prompt, then closes fd 1 and stays alive.
const CLOSES_STDOUT_MID_TURN = String.raw`
  const fs = require('node:fs')
  fs.writeFileSync(process.env.ORCA_TEST_PID_FILE, String(process.pid))
  const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
  let buffered = ''
  process.stdin.setEncoding('utf8').on('data', (chunk) => {
    buffered += chunk
    let newline
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const frame = JSON.parse(buffered.slice(0, newline))
      buffered = buffered.slice(newline + 1)
      if (frame.method === 'initialize') {
        send({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: {} } })
      } else if (frame.method === 'session/new') {
        send({ id: frame.id, result: JSON.parse(process.env.ORCA_TEST_SESSION) })
      } else if (frame.method === 'session/prompt') {
        const update = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } }
        send({
          method: 'session/update',
          params: { sessionId: frame.params.sessionId, update, _meta: frame.params._meta }
        })
        process.stdout.write('', () => fs.closeSync(1))
      }
    }
  })
  setInterval(() => {}, 60000)
`

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('ACP agent that closes its stdout but keeps running', () => {
  it('reads the closed stream as a broken connection: turn unverifiable, child stopped, ended once', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'orca-acp-broken-stream-')), 'pid')
    const rig = await openAcpAdapterRig({
      deps: {
        spawnChild: () =>
          spawnAcpStructuredChild({
            command: process.execPath,
            args: ['-e', CLOSES_STDOUT_MID_TURN],
            cwd: process.cwd(),
            env: {
              ORCA_TEST_PID_FILE: pidFile,
              ORCA_TEST_SESSION: JSON.stringify({
                sessionId: PROVIDER_SESSION,
                configOptions: GROK_CONFIG_OPTIONS
              })
            }
          })
      }
    })
    onTestFinished(async () => {
      await rig.adapter.closeAll().catch(() => {})
    })
    await rig.acquire()
    await sendHello(rig, 'broken')
    const turns = async () =>
      (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
    await vi.waitFor(
      async () => expect((await turns()).at(-1)).toMatchObject({ state: 'unverifiable' }),
      { timeout: 10_000, interval: 20 }
    )
    await vi.waitFor(
      () =>
        expect(rig.lifecycle).toMatchObject([
          { type: 'ended', cause: 'unexpected-exit', acquisitionGeneration: 'gen-acp' }
        ]),
      { timeout: 15_000, interval: 20 }
    )
    expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false)
    expect((await turns()).some((turn) => turn.state === 'completed')).toBe(false)
  }, 30_000)
})
