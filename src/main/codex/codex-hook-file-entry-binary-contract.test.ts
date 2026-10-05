import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CodexHookListing } from './codex-app-server-client'
import { getCodexManagedHookInstallMaterial } from './codex-hook-definition'
import {
  deriveCodexHookHashes,
  listCodexHooks,
  type CodexHookHashes
} from './codex-hook-trust-derivation'
import { reconcileRealHomeCodexHookEntries } from './codex-real-home-hook-install'
import {
  computeTrustKey,
  normalizeHookTrustKeyForLookup,
  upsertHookTrustEntries
} from './config-toml-trust'

// Why this file exists: Orca writes Codex's approval of its status hook itself,
// from the hash Codex reports for the hook in a throwaway home. Only a real
// binary can say whether that hash and Orca's key for ~/.codex still match what
// Codex computes, whether the entry then runs in a real turn with no review, and
// whether a user's hook inserted ahead puts it up for review until Orca
// reconciles. If any of those drift, users meet a review screen or lose status
// while every unit test stays green.

const execFileAsync = promisify(execFile)
const binary = process.env.ORCA_CODEX_HOOK_CONTRACT_BINARY
const expectedVersion = process.env.ORCA_CODEX_HOOK_CONTRACT_VERSION
const TIMEOUT_MS = 60_000

describe.runIf(process.env.ORCA_CODEX_HOOK_CONTRACT_REQUIRED === '1' && !binary)(
  'codex hook file-entry contract prerequisites',
  () => {
    it('was given a Codex binary to run against', () => {
      expect.fail('ORCA_CODEX_HOOK_CONTRACT_REQUIRED=1 but no binary was given')
    })
  }
)

describe.runIf(binary)('codex hook file-entry binary contract', { timeout: 180_000 }, () => {
  let root: string
  let home: string
  let hashes: CodexHookHashes

  beforeAll(async () => {
    // Why a disposable HOME: the entry goes to $HOME/.codex, never the user's own.
    root = mkdtempSync(join(tmpdir(), 'orca-codex-hook-contract-'))
    const version = await execFileAsync(binary!, ['--version'], {
      timeout: TIMEOUT_MS,
      env: { ...process.env, HOME: join(root, 'version-home'), CODEX_HOME: join(root, 'v') }
    })
    if (expectedVersion) {
      expect(version.stdout.trim()).toBe(`codex-cli ${expectedVersion}`)
    }
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function freshHomeWithEntry(name: string): Promise<void> {
    // Why a symlinked HOME: Codex keys the default home as spelled, so a resolved key would miss.
    home = join(root, `${name}-home`)
    symlinkSync(mkdtempSync(join(root, `${name}-`)), home, 'junction')
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CODEX_HOME', '')
    const derived = await deriveCodexHookHashes(binary!, command())
    expect(derived.failure).toBeNull()
    hashes = derived.hashes!
    expect(await reconcile()).toBe('written')
  }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const command = (): string => getCodexManagedHookInstallMaterial().command
  const codexHome = (): string => join(home, '.codex')

  async function reconcile(): Promise<string> {
    return (
      await reconcileRealHomeCodexHookEntries({
        hashes,
        isEnabled: () => true,
        userDataPath: join(home, 'user-data')
      })
    ).outcome
  }

  async function orcaListings(): Promise<CodexHookListing[]> {
    // Why a cwd outside any project: only the home's own hooks.json is listed.
    const cwd = mkdtempSync(join(root, 'cwd-'))
    return (await listCodexHooks(binary!, null, cwd)).filter(
      (listing) => listing.command === command()
    )
  }

  it('lists every entry Orca wrote as trusted and enabled, and writes nothing on a list', async () => {
    await freshHomeWithEntry('trusted')
    const before = ['hooks.json', 'config.toml'].map((name) =>
      readFileSync(join(codexHome(), name), 'utf-8')
    )

    const listings = await orcaListings()

    expect(listings.map((listing) => listing.key.split(':').at(-3)).sort()).toEqual(
      Object.keys(hashes).sort()
    )
    expect(listings.every((listing) => listing.trustStatus === 'trusted')).toBe(true)
    expect(listings.every((listing) => listing.enabled !== false)).toBe(true)
    expect(
      ['hooks.json', 'config.toml'].map((name) => readFileSync(join(codexHome(), name), 'utf-8'))
    ).toEqual(before)
    expect(await reconcile()).toBe('unchanged')
  })

  it("keeps the entry on over the user's /hooks off switch once Orca reconciles", async () => {
    await freshHomeWithEntry('switched-off')
    const stop = {
      sourcePath: join(codexHome(), 'hooks.json'),
      eventLabel: 'stop' as const,
      groupIndex: 0,
      handlerIndex: 0,
      command: command()
    }
    const listed = async (): Promise<CodexHookListing | undefined> =>
      (await orcaListings()).find(
        (listing) =>
          normalizeHookTrustKeyForLookup(listing.key) ===
          normalizeHookTrustKeyForLookup(computeTrustKey(stop))
      )
    upsertHookTrustEntries(join(codexHome(), 'config.toml'), [
      { ...stop, trustedHash: hashes.stop, enabled: false }
    ])
    expect((await listed())?.enabled).toBe(false)

    expect(await reconcile()).toBe('written')

    expect((await listed())?.enabled).toBe(true)
  })

  it('shows the entry for review after a user inserts a hook ahead of it, until Orca reconciles', async () => {
    await freshHomeWithEntry('inserted')
    const hooksPath = join(codexHome(), 'hooks.json')
    const file = JSON.parse(readFileSync(hooksPath, 'utf-8'))
    file.hooks.Stop.unshift({ hooks: [{ type: 'command', command: 'true' }] })
    writeFileSync(hooksPath, `${JSON.stringify(file, null, 2)}\n`)

    const shifted = (await orcaListings()).find((listing) => listing.key.endsWith(':stop:1:0'))
    expect(shifted?.trustStatus).not.toBe('trusted')

    expect(await reconcile()).toBe('written')

    const listings = await orcaListings()
    expect(listings.find((listing) => listing.key.endsWith(':stop:1:0'))?.trustStatus).toBe(
      'trusted'
    )
    expect(listings.every((listing) => listing.trustStatus === 'trusted')).toBe(true)
    // Why: the key Orca keys its approval by is the one Codex lists for its entry.
    expect(normalizeHookTrustKeyForLookup(shifted!.key)).toBe(
      normalizeHookTrustKeyForLookup(
        computeTrustKey({
          sourcePath: join(codexHome(), 'hooks.json'),
          eventLabel: 'stop',
          groupIndex: 1,
          handlerIndex: 0,
          command: command()
        })
      )
    )
  })

  it.skipIf(process.platform === 'win32')(
    'runs the entry in a real turn with no review, posting to the pane that started Codex',
    async () => {
      await freshHomeWithEntry('exec')
      const posts: string[] = []
      const receiver = await listen(
        createServer((request, response) => {
          request.resume()
          request.on('end', () => {
            posts.push(request.url ?? '')
            response.writeHead(204).end()
          })
        })
      )
      const model = await startMockResponses()
      let stderr = ''
      try {
        const workdir = join(home, 'work')
        mkdirSync(workdir)
        const run = execFileAsync(
          binary!,
          [
            '-c',
            'model_provider=mock',
            '-c',
            `model_providers.mock={name="mock",base_url="http://127.0.0.1:${port(model)}/v1",wire_api="responses",env_key="ORCA_CONTRACT_MOCK_KEY"}`,
            'exec',
            '--skip-git-repo-check',
            'say hi'
          ],
          {
            cwd: workdir,
            timeout: TIMEOUT_MS,
            env: {
              PATH: process.env.PATH,
              HOME: home,
              ORCA_CONTRACT_MOCK_KEY: 'x',
              ORCA_PANE_KEY: 'contract-pane',
              ORCA_AGENT_HOOK_PORT: String(port(receiver)),
              ORCA_AGENT_HOOK_TOKEN: 'contract-token'
            }
          }
        )
        // Why: `codex exec` also reads a prompt from stdin until it closes.
        run.child.stdin?.end()
        stderr = (await run).stderr
      } finally {
        model.close()
        receiver.close()
      }
      expect(posts.length).toBeGreaterThan(0)
      expect(posts.every((url) => url.includes('codex'))).toBe(true)
      expect(stderr).not.toMatch(/review|untrusted|clamp/i)
    }
  )
})

function listen(server: Server): Promise<Server> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function port(server: Server): number {
  const address = server.address()
  return address && typeof address === 'object' ? address.port : 0
}

/** A minimal Responses stream: one assistant message, then completion. */
function startMockResponses(): Promise<Server> {
  const event = (payload: Record<string, unknown>): string =>
    `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`
  return listen(
    createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
          response.writeHead(404).end()
          return
        }
        const id = 'resp_contract'
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          event({ type: 'response.created', response: { id } }) +
            event({
              type: 'response.output_item.done',
              item: {
                type: 'message',
                role: 'assistant',
                id: 'msg_contract',
                content: [{ type: 'output_text', text: 'hi' }]
              }
            }) +
            event({
              type: 'response.completed',
              response: {
                id,
                usage: {
                  input_tokens: 0,
                  input_tokens_details: null,
                  output_tokens: 0,
                  output_tokens_details: null,
                  total_tokens: 0
                }
              }
            })
        )
      })
    })
  )
}
