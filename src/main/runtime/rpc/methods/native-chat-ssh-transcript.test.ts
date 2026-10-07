import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { IFilesystemProvider } from '../../../providers/types'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../../../providers/ssh-filesystem-dispatch'

const hookRows = vi.hoisted(() => ({ value: new Array<unknown>() }))
vi.mock('../../../agent-hooks/server', () => ({
  agentHookServer: { getStatusSnapshot: () => hookRows.value }
}))

import { eraseRpcMethods, type RpcContext } from '../core'
import { NATIVE_CHAT_METHODS } from './native-chat'

const CONNECTION_ID = 'ssh-target-26057'
const SESSION_ID = 'claude-session-26057'

function claudeLines(...texts: string[]): string {
  return texts
    .map((text, index) =>
      JSON.stringify({
        sessionId: SESSION_ID,
        uuid: `${SESSION_ID}-${index}`,
        timestamp: '2026-10-07T03:00:00.000Z',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] }
      })
    )
    .map((line) => `${line}\n`)
    .join('')
}

/** An SSH host's filesystem as the relay serves it: stat plus positional reads. */
function sshHost(files: Map<string, string>): IFilesystemProvider {
  const bytes = (path: string): Buffer => {
    const body = files.get(path)
    if (body === undefined) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    }
    return Buffer.from(body)
  }
  const provider: Pick<IFilesystemProvider, 'stat' | 'readFileRange'> = {
    stat: async (path) => ({
      size: bytes(path).length,
      type: 'file',
      mtime: 0,
      mtimeMs: bytes(path).length,
      dev: 1,
      ino: 1
    }),
    readFileRange: async (path, position, length) => {
      const slice = bytes(path).subarray(position, position + length)
      return { bytes: slice, bytesRead: slice.length }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: transcript reads use only stat and readFileRange.
  return provider as IFilesystemProvider
}

function sshHookRow(transcriptPath: string): Partial<AgentStatusIpcPayload> {
  return {
    paneKey: 'tab-1:leaf-1',
    connectionId: CONNECTION_ID,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: SESSION_ID, transcriptPath }
  }
}

const METHODS = eraseRpcMethods(NATIVE_CHAT_METHODS)

type SubscriptionRuntime = Pick<
  RpcContext['runtime'],
  'registerSubscriptionCleanup' | 'cleanupSubscription'
>

function phoneContext(runtime: Partial<SubscriptionRuntime>): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native chat handlers use only the subscription-cleanup members.
  const handlerRuntime = runtime as RpcContext['runtime']
  return { runtime: handlerRuntime, connectionId: 'phone-1', clientKind: 'mobile' }
}

function method(name: string): (typeof METHODS)[number] {
  const found = METHODS.find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`${name} is not registered`)
  }
  return found
}

function texts(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !('messages' in value)) {
    return []
  }
  const messages: readonly NativeChatMessage[] = Array.isArray(value.messages) ? value.messages : []
  return messages.flatMap((message) =>
    message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
  )
}

async function readSession(transcriptPath: string): Promise<{ texts: string[]; error: unknown }> {
  const read = method('nativeChat.readSession')
  if ('stream' in read) {
    throw new Error('nativeChat.readSession is a stream')
  }
  const page = await read.handler(
    { agent: 'claude', sessionId: SESSION_ID, transcriptPath },
    phoneContext({})
  )
  return {
    texts: texts(page),
    error: page && typeof page === 'object' && 'error' in page ? page.error : undefined
  }
}

describe('native chat for an agent whose transcript lives on an SSH host (#26057)', () => {
  let localDir: string
  // The path the remote hook reported. A same-named file exists on this machine too, so a read
  // that answers locally shows the wrong conversation instead of failing quietly.
  let transcriptPath: string

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), 'orca-ssh-transcript-'))
    transcriptPath = join(localDir, 'projects', 'p', `${SESSION_ID}.jsonl`)
    mkdirSync(dirname(transcriptPath), { recursive: true })
    writeFileSync(transcriptPath, claudeLines('LOCAL MACHINE FILE'))
    hookRows.value = [sshHookRow(transcriptPath)]
  })

  afterEach(() => {
    unregisterSshFilesystemProvider(CONNECTION_ID)
    rmSync(localDir, { recursive: true, force: true })
  })

  it('reads the history from the SSH host the hook store attests the session to', async () => {
    registerSshFilesystemProvider(
      CONNECTION_ID,
      sshHost(new Map([[transcriptPath, claudeLines('first remote turn', 'second remote turn')]]))
    )

    const page = await readSession(transcriptPath)

    expect(page.error).toBeUndefined()
    expect(page.texts).toEqual(['first remote turn', 'second remote turn'])
  })

  it('streams the SSH host history and its later turns to a subscribed phone', async () => {
    const files = new Map([[transcriptPath, claudeLines('remote history')]])
    registerSshFilesystemProvider(CONNECTION_ID, sshHost(files))
    const frames: unknown[] = []
    let cleanup = (): void => {}
    const subscribe = method('nativeChat.subscribe')
    if (!('stream' in subscribe)) {
      throw new Error('nativeChat.subscribe is not a stream')
    }

    await subscribe.handler(
      { agent: 'claude', sessionId: SESSION_ID, transcriptPath, subscriptionId: 'sub-1' },
      phoneContext({
        registerSubscriptionCleanup: (_id, fn) => {
          cleanup = fn
        },
        cleanupSubscription: () => cleanup()
      }),
      (frame) => frames.push(frame)
    )
    try {
      await vi.waitFor(() => expect(texts(frames[0])).toEqual(['remote history']))
      files.set(transcriptPath, claudeLines('remote history', 'remote follow-up'))
      await vi.waitFor(
        () =>
          expect(
            frames
              .filter(
                (frame) =>
                  frame && typeof frame === 'object' && 'type' in frame && frame.type === 'appended'
              )
              .flatMap((frame) => texts(frame))
          ).toEqual(['remote follow-up']),
        { timeout: 5_000 }
      )
    } finally {
      cleanup()
    }
  })

  it('never answers from this machine while the SSH host is disconnected', async () => {
    const page = await readSession(transcriptPath)

    expect(page.texts).toEqual([])
    expect(page.error).toBeDefined()
  })

  it('keeps reading a local session from this machine', async () => {
    hookRows.value = [{ ...sshHookRow(transcriptPath), connectionId: null }]

    const page = await readSession(transcriptPath)

    expect(page.texts).toEqual(['LOCAL MACHINE FILE'])
  })
})
