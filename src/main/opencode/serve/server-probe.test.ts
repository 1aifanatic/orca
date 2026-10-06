import { describe, expect, it, vi } from 'vitest'
import { OpenCodeHttpPeer } from './http-peer'
import { probeOpenCodeServer } from './server-probe'

type RecordedResponse = { status: number; contentType?: string; body: string }
const html = { status: 200, contentType: 'text/html', body: '<!doctype html>\n<html lang="en">\n' }
const recordedV1: Record<string, RecordedResponse> = {
  '/api/info': html,
  '/global/health': {
    status: 200,
    contentType: 'application/json',
    body: '{"healthy":true,"version":"1.18.32"}'
  }
}
const recordedV2: Record<string, RecordedResponse> = {
  '/api/info': {
    status: 200,
    contentType: 'application/json',
    body: '{"version":"2.0.18","pid":2393556,"urls":["http://127.0.0.1:48771"],"paths":{"tmp":"/tmp/opencode"}}'
  },
  '/global/health': html
}

function replay(responses: Readonly<Record<string, RecordedResponse | undefined>>) {
  const fetchImpl = vi.fn<typeof fetch>(async (url) => {
    const response = responses[new URL(String(url)).pathname] ?? html
    return new Response(response.body, {
      status: response.status,
      headers: response.contentType ? { 'content-type': response.contentType } : {}
    })
  })
  return {
    fetchImpl,
    peer: new OpenCodeHttpPeer({ port: 48271, password: 'fixture', fetch: fetchImpl })
  }
}

describe('OpenCode server version probe', () => {
  it.each([
    [recordedV1, 1, '1.18.32'],
    [recordedV2, 2, '2.0.18']
  ] as const)('identifies recorded server responses', async (responses, major, version) => {
    const { peer, fetchImpl } = replay(responses)
    await expect(probeOpenCodeServer(peer, new AbortController().signal)).resolves.toEqual({
      major,
      version
    })
    expect(fetchImpl).toHaveBeenCalledTimes(major === 1 ? 2 : 1)
    peer.close()
  })

  it('rejects wrong-path HTML success and a JSON body without native proof', async () => {
    for (const responses of [
      {},
      {
        '/api/info': { status: 200, contentType: 'application/json', body: '{"version":"2.0.18"}' }
      }
    ]) {
      const { peer } = replay(responses)
      await expect(probeOpenCodeServer(peer, new AbortController().signal)).rejects.toThrow(
        'did not identify'
      )
      peer.close()
    }
  })

  it('does not infer a version or try another route on a password refusal', async () => {
    const { peer, fetchImpl } = replay({ '/api/info': { status: 401, body: '' } })
    await expect(probeOpenCodeServer(peer, new AbortController().signal)).rejects.toMatchObject({
      kind: 'status',
      status: 401
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    peer.close()
  })

  it.each(['1.14.18', '1.14.19-beta', '1.14.19-rc.1', '0.9.0', '3.0.0', 'invalid'])(
    'refuses unsupported version %s',
    async (version) => {
      const { peer } = replay({
        '/global/health': {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ healthy: true, version })
        }
      })
      await expect(probeOpenCodeServer(peer, new AbortController().signal)).rejects.toThrow(
        'requires version'
      )
      peer.close()
    }
  )

  it.each(['1.14.19', '1.14.19+build.1', '1.14.20-beta'])(
    'accepts version %s at or above the release floor',
    async (version) => {
      const { peer } = replay({
        '/global/health': {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ healthy: true, version })
        }
      })
      await expect(probeOpenCodeServer(peer, new AbortController().signal)).resolves.toEqual({
        major: 1,
        version
      })
      peer.close()
    }
  )
})
