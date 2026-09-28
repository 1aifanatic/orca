import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'bun:test'

const candidateHashes = {
  x64: 'e1704a213d9e1634920d5b7d97b9d97f637b232059fb152a0f0bd48930ad463e',
  arm64: '9ca4184dd4e4dc7f9575075ab4ce6b00fb1feac59110d68c660177c5447ad526'
}
const providerHashes = {
  x64: '7c7430632052ff703540b68371ec43821820aa1335d8e11dfbcd9ff00e9daaed',
  arm64: 'b6cca5f1081111f59e5255eec043d924ebd11a86d09986c0d121b680540b3380'
}
const fixture = fileURLToPath(new URL('./provider-selection-child.mjs', import.meta.url))
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
let provider

async function isolated(mode, selector) {
  const env = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', BUN_CONPTY_LIBRARY: selector }
  for (const key of Object.keys(env)) {
    if (/^(NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|BUN_INSPECT.*)$/i.test(key)) delete env[key]
  }
  if (selector === undefined) delete env.BUN_CONPTY_LIBRARY
  const child = Bun.spawn([process.execPath, fixture, mode, provider], {
    env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'
  })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 20_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
    ])
    expect(timedOut, stderr).toBe(false)
    expect(exitCode, stderr).toBe(0)
    return JSON.parse(stdout)
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}

describe.skipIf(process.platform !== 'win32')('patched Bun ConPTY provider selection', () => {
  beforeAll(() => {
    expect(candidateHashes[process.arch]).toBeDefined()
    expect(digest(process.execPath)).toBe(candidateHashes[process.arch])
    provider = process.env.BUN_CONPTY_LIBRARY
    expect(typeof provider).toBe('string')
    expect(isAbsolute(provider)).toBe(true)
    expect(digest(provider)).toBe(providerHashes[process.arch])
  })

  it('refuses a relative provider instead of silently using inbox ConPTY', async () => {
    expect((await isolated('reject', 'conpty.dll')).rejected).toBe(true)
  }, 25_000)

  it('refuses a missing absolute provider instead of silently using inbox ConPTY', async () => {
    const missing = join(tmpdir(), `orca-missing-provider-${randomUUID()}`, 'conpty.dll')
    expect(existsSync(missing)).toBe(false)
    expect((await isolated('reject', missing)).rejected).toBe(true)
  }, 25_000)

  it('refuses a real DLL without the Conpty exports instead of using inbox functions', async () => {
    const noSymbols = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'kernel32.dll')
    expect(existsSync(noSymbols)).toBe(true)
    expect((await isolated('reject', noSymbols)).rejected).toBe(true)
  }, 25_000)

  it('refuses the other architecture provider instead of silently using inbox ConPTY', async () => {
    const otherArch = process.arch === 'arm64' ? 'x64' : 'arm64'
    const otherProvider = process.env.ORCA_OPPOSITE_CONPTY_LIBRARY ??
      join(dirname(dirname(provider)), otherArch, 'conpty.dll')
    expect(isAbsolute(otherProvider)).toBe(true)
    expect(digest(otherProvider)).toBe(providerHashes[otherArch])
    expect((await isolated('reject', otherProvider)).rejected).toBe(true)
  }, 25_000)

  it.each(['invalid', 'unset'])(
    'honors a verified JS selector before the first Terminal when inherited selector is %s',
    async (inheritedMode) => {
      const selector = inheritedMode === 'invalid' ? 'not-an-absolute-provider.dll' : undefined
      const result = await isolated('set-before-first-terminal', selector)
      expect(result.inherited).toBe(selector ?? null)
      expect(result.cycle.exitCode).toBe(0)
      expect(result.cycle.markerSeen).toBe(true)
      expect(result.cycle.answered).toBe(true)
    },
    25_000
  )

  it('keeps a failed provider selection failed for the process lifetime', async () => {
    const result = await isolated('cached-failure', 'conpty.dll')
    expect(result.first.rejected).toBe(true)
    expect(result.second.rejected).toBe(true)
  }, 25_000)

  it('retains the selected provider across resize and repeated off-thread closes', async () => {
    const { cycles } = await isolated('cached-success', provider)
    expect(cycles).toHaveLength(8)
    for (const cycle of cycles) {
      expect(cycle.exitCode).toBe(0)
      expect(cycle.markerSeen).toBe(true)
      expect(cycle.answered).toBe(true)
    }
  }, 25_000)
})
