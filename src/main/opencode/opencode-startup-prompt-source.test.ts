import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OPENCODE_STARTUP_PROMPT_SHA256_ENV,
  OPENCODE_STARTUP_PROMPT_NONCE_ENV,
  OPENCODE_STARTUP_PROMPT_BODY_ENV,
  OPENCODE_STARTUP_PROMPT_ENDPOINT_ENV
} from '../../shared/opencode-startup-prompt'
import { getOpenCodeStartupPromptSource } from './opencode-startup-prompt-source'

type PluginModule = { default: { setup: (ctx: unknown) => Promise<() => Promise<void>> } }
const prompt = 'exact startup brief\nwith unicode é'
const digest = createHash('sha256').update(prompt).digest('hex')
let dir: string
let setup: PluginModule['default']['setup']
let claim: ReturnType<typeof vi.fn>

class Editor extends EventEmitter {
  traits: { owner: string; role: string; capture: string[]; status?: string } = {
    owner: 'opencode',
    role: 'prompt',
    capture: ['tab']
  }
  plainText = ''
  focused = true
  insertText(text: string) {
    this.replace(this.plainText + text)
  }
  replace(text: string) {
    this.plainText = text
    this.emit('line-info-change')
  }
}

function fixture() {
  const editor = new Editor()
  const input = new EventEmitter()
  const memory = { settled: false, expiresAt: Date.now() + 20000 }
  const route = { type: 'home' }
  const agent = vi.fn((): unknown[] | undefined => [{}])
  const model = vi.fn((): unknown[] | undefined => [{}])
  const dispatch = vi.fn(() => editor.replace(''))
  const ctx = {
    app: { version: '2.0.16' },
    renderer: { keyInput: input, currentFocusedEditor: editor },
    storage: { memory: () => [memory, (mutate: (draft: typeof memory) => void) => mutate(memory)] },
    keymap: { dispatch },
    ui: { router: { current: () => route } },
    location: { directory: '/private' },
    data: { location: { agent: { list: agent }, model: { list: model } } }
  }
  return { ctx, editor, input, memory, route, agent, model, dispatch }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-opencode-prompt-'))
  const path = join(dir, 'prompt.mjs')
  writeFileSync(path, getOpenCodeStartupPromptSource())
  const module: PluginModule = await import(pathToFileURL(path).href)
  setup = module.default.setup
  vi.useFakeTimers()
  vi.stubEnv(OPENCODE_STARTUP_PROMPT_SHA256_ENV, digest)
  vi.stubEnv(OPENCODE_STARTUP_PROMPT_BODY_ENV, prompt)
  vi.stubEnv(OPENCODE_STARTUP_PROMPT_NONCE_ENV, 'single-use-nonce')
  const endpoint = join(dir, 'endpoint.cmd')
  writeFileSync(
    endpoint,
    'set ORCA_AGENT_HOOK_PORT=12345\nset ORCA_AGENT_HOOK_TOKEN=private-token\nset ORCA_AGENT_HOOK_ENV=test\nset ORCA_AGENT_HOOK_VERSION=1\n'
  )
  vi.stubEnv(OPENCODE_STARTUP_PROMPT_ENDPOINT_ENV, endpoint)
  claim = vi.fn(async () => ({ ok: true, json: async () => ({ allowed: true }) }))
  vi.stubGlobal('fetch', claim)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('installed-version native prompt intent plugin', () => {
  it.each(['dialog', 'shell', 'autocomplete'])('does not populate a %s editor', async (kind) => {
    const f = fixture()
    if (kind === 'dialog') {
      f.editor.traits.role = 'dialog'
    }
    if (kind === 'shell') {
      f.editor.traits.status = 'SHELL'
    }
    if (kind === 'autocomplete') {
      f.editor.traits.capture = ['escape', 'navigate', 'submit', 'tab']
    }
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.editor.plainText).toBe('')
    expect(claim).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
    await dispose()
  })
  it('retries only explicitly pending admission, then submits once', async () => {
    claim.mockResolvedValueOnce({ ok: true, json: async () => ({ allowed: false, pending: true }) })
    const f = fixture()
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(100)
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1))
    expect(f.dispatch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1))
    expect(claim).toHaveBeenCalledTimes(2)
    await dispose()
  })

  it('cancels pending admission on input without retrying a consumed denial', async () => {
    claim.mockResolvedValue({ ok: true, json: async () => ({ allowed: false, pending: true }) })
    const f = fixture()
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(100)
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1))
    f.input.emit('keypress', { name: 'x' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(claim).toHaveBeenCalledTimes(1)
    expect(f.dispatch).not.toHaveBeenCalled()
    await dispose()
  })

  it('preserves typing that predates plugin setup without requesting owner permission', async () => {
    const f = fixture()
    f.editor.replace('early typing')
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.editor.plainText).toBe('early typing')
    expect(claim).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
    await dispose()
  })
  it('waits for catalogs and dispatches only until OpenCode clears the exact draft', async () => {
    const f = fixture()
    f.model.mockReturnValue(undefined)
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.dispatch).not.toHaveBeenCalled()
    f.model.mockReturnValue([{}])
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledExactlyOnceWith('prompt.submit'))
    expect(claim).toHaveBeenCalledTimes(1)
    expect(f.memory.settled).toBe(true)
    f.editor.replace(prompt)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    await dispose()
    const reloadDispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    await reloadDispose()
  })

  it.each(['keypress', 'paste'])('cancels on physical %s before catalogs finish', async (event) => {
    const f = fixture()
    f.agent.mockReturnValue(undefined)
    const dispose = await setup(f.ctx)
    f.input.emit(event)
    f.agent.mockReturnValue([{}])
    await vi.advanceTimersByTimeAsync(500)
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.memory.settled).toBe(true)
    await dispose()
  })

  it('cancels a changed draft even when it is restored before the next tick', async () => {
    const f = fixture()
    f.model.mockReturnValue(undefined)
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(100)
    f.editor.replace('edited')
    f.editor.replace('')
    f.model.mockReturnValue([{}])
    await vi.advanceTimersByTimeAsync(500)
    expect(f.dispatch).not.toHaveBeenCalled()
    await dispose()
  })

  it('cancels pending intent on route changes, expiration and disposal', async () => {
    for (const reason of ['route', 'expiration', 'dispose']) {
      const f = fixture()
      f.model.mockReturnValue(undefined)
      const dispose = await setup(f.ctx)
      if (reason === 'route') {
        f.route.type = 'session'
      }
      if (reason === 'expiration') {
        f.memory.expiresAt = Date.now()
      }
      if (reason === 'dispose') {
        await dispose()
      }
      await vi.advanceTimersByTimeAsync(100)
      f.model.mockReturnValue([{}])
      await vi.advanceTimersByTimeAsync(500)
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(f.memory.settled).toBe(true)
      await dispose()
      expect(f.input.listenerCount('keypress')).toBe(0)
    }
  })

  it('leaves unverified versions and mismatched drafts unsubmitted', async () => {
    const f = fixture()
    f.ctx.app.version = '2.0.17'
    await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.dispatch).not.toHaveBeenCalled()
    f.ctx.app.version = '2.0.16'
    f.editor.replace('another brief')
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.dispatch).not.toHaveBeenCalled()
    await dispose()
  })

  it.each(['canceled', 'unavailable'])(
    'fails closed when the execution owner is %s',
    async (reason) => {
      claim.mockImplementation(async () => {
        if (reason === 'unavailable') {
          throw new Error('contact lost')
        }
        return { ok: true, json: async () => ({ allowed: false }) }
      })
      const f = fixture()
      const dispose = await setup(f.ctx)
      await vi.advanceTimersByTimeAsync(500)
      expect(f.dispatch).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(f.memory.settled).toBe(true))
      await dispose()
    }
  )

  it('rechecks physical cancellation after the owner response', async () => {
    const f = fixture()
    claim.mockImplementation(async () => {
      f.input.emit('keypress')
      return { ok: true, json: async () => ({ allowed: true }) }
    })
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(f.memory.settled).toBe(true))
    expect(f.dispatch).not.toHaveBeenCalled()
    await dispose()
  })
})
