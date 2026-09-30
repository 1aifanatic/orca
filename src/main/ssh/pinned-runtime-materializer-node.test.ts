import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import {
  NODE_RUNTIME_ASSETS,
  NODE_RUNTIME_PIN,
  nodeRuntimeExecutablePath
} from '../../shared/node-runtime-pin'
import {
  materializeCachedNodeRuntime,
  materializeNodeRuntimeArchive
} from './pinned-runtime-materializer'

const TARGET = 'linux-x64-glibc' as const
const originalAsset = { ...NODE_RUNTIME_ASSETS[TARGET] }
let root = ''

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function fetcherFor(body: Uint8Array): typeof fetch {
  return vi.fn<typeof fetch>(async () => new Response(Buffer.from(body), { status: 200 }))
}

/** A real .tar.gz laid out like the official one, so extraction runs the host's tar. */
async function officialShapedArchive(executable: Uint8Array): Promise<Uint8Array> {
  const staging = join(root, 'staging')
  const member = nodeRuntimeExecutablePath(TARGET, NODE_RUNTIME_ASSETS[TARGET].archive)
  await mkdir(join(staging, member, '..'), { recursive: true })
  await writeFile(join(staging, member), executable)
  await writeFile(join(staging, member.split('/')[0]!, 'README.md'), 'not extracted')
  const archivePath = join(root, 'archive.tar.gz')
  const result = await runProcess({
    program: 'tar',
    args: ['-czf', archivePath, '-C', staging, member.split('/')[0]!]
  })
  expect(result.code, result.stderr).toBe(0)
  return new Uint8Array(await readFile(archivePath))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-node-runtime-materializer-'))
})

afterEach(async () => {
  Object.assign(NODE_RUNTIME_ASSETS[TARGET], originalAsset)
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('pinned Node runtime materializer', () => {
  it('caches the executable by its digest from a verified official-shaped archive', async () => {
    const executable = new TextEncoder().encode('pinned node executable')
    const archive = await officialShapedArchive(executable)
    Object.assign(NODE_RUNTIME_ASSETS[TARGET], {
      archiveSha256: sha256(archive),
      executableSha256: sha256(executable)
    })
    const cacheRoot = join(root, 'cache')
    const fetcher = fetcherFor(archive)

    const runtime = await materializeCachedNodeRuntime(TARGET, cacheRoot, { fetcher })

    expect(runtime).toBe(join(cacheRoot, 'node', sha256(executable), 'node'))
    expect(await readFile(runtime)).toEqual(Buffer.from(executable))
    expect((await stat(runtime)).mode & 0o111).toBe(0o111)
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining(`/v${NODE_RUNTIME_PIN.version}/${originalAsset.archive}`),
      expect.objectContaining({ redirect: 'follow' })
    )
    await expect(materializeCachedNodeRuntime(TARGET, cacheRoot, { fetcher })).resolves.toBe(
      runtime
    )
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('keeps the verified archive for upload and refetches only when it is corrupted', async () => {
    const archive = await officialShapedArchive(new TextEncoder().encode('node'))
    Object.assign(NODE_RUNTIME_ASSETS[TARGET], { archiveSha256: sha256(archive) })
    const cacheRoot = join(root, 'cache')
    const fetcher = fetcherFor(archive)

    const cached = await materializeNodeRuntimeArchive(TARGET, cacheRoot, { fetcher })
    expect(cached.endsWith(originalAsset.archive)).toBe(true)
    expect(await materializeNodeRuntimeArchive(TARGET, cacheRoot, { fetcher })).toBe(cached)
    expect(fetcher).toHaveBeenCalledOnce()

    await writeFile(cached, 'torn')
    const repaired = await materializeNodeRuntimeArchive(TARGET, cacheRoot, { fetcher })
    expect(repaired).not.toBe(cached)
    expect(sha256(new Uint8Array(await readFile(repaired)))).toBe(sha256(archive))
  })

  it('refuses an archive that does not match the pin before extracting it', async () => {
    const archive = await officialShapedArchive(new TextEncoder().encode('node'))
    await expect(
      materializeCachedNodeRuntime(TARGET, join(root, 'cache'), { fetcher: fetcherFor(archive) })
    ).rejects.toThrow('Node archive checksum mismatch')
  })
})
