import { z } from 'zod'
import { OpenCodeHttpError, openCodeMediaType } from './http-response'
import type { OpenCodeHttpPeer } from './http-peer'

export type OpenCodeServerVersion = { major: 1 | 2; version: string }

const infoSchema = z.object({ version: z.string(), pid: z.number().int().positive() })
const healthSchema = z.object({ version: z.string(), healthy: z.literal(true) })

function supportedVersion(version: string): OpenCodeServerVersion {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  const major = Number(match?.[1])
  const minor = Number(match?.[2])
  const patch = Number(match?.[3])
  if (major === 2) {
    return { major, version }
  }
  if (major === 1 && (minor > 14 || (minor === 14 && patch >= 19))) {
    return { major, version }
  }
  throw new OpenCodeHttpError(
    'invalid-response',
    'OpenCode requires version 1.14.19 or newer in 1.x, or 2.x'
  )
}

/** Unknown routes return the web UI with HTTP 200; only the native JSON shape proves readiness. */
export async function probeOpenCodeServer(
  peer: Pick<OpenCodeHttpPeer, 'request'>,
  signal: AbortSignal
): Promise<OpenCodeServerVersion> {
  for (const path of ['/api/info', '/global/health'] as const) {
    const response = await peer.request(path, { signal, timeoutMs: 5_000 })
    if (response.status === 401) {
      throw new OpenCodeHttpError('status', 'OpenCode server rejected its private password', 401)
    }
    if (response.status !== 200 || openCodeMediaType(response) !== 'application/json') {
      continue
    }
    let body: unknown
    try {
      body = JSON.parse(await response.text())
    } catch {
      continue
    }
    const parsed = path === '/api/info' ? infoSchema.safeParse(body) : healthSchema.safeParse(body)
    if (parsed.success) {
      return supportedVersion(parsed.data.version)
    }
  }
  throw new OpenCodeHttpError('invalid-response', 'Server did not identify itself as OpenCode')
}
