import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RpcDispatcher } from './dispatcher'
import { defineMethod, type RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only getRuntimeId on this path; any other runtime member it touched would throw rather than read a wrong value.
const RUNTIME = { getRuntimeId: () => 'test-runtime' } as OrcaRuntimeService

const INSPECT = defineMethod({
  name: 'test.inspectCaller',
  params: z.object({}),
  handler: (_params, { trustedLocalCallerId }) => ({
    trustedLocalCallerId: trustedLocalCallerId ?? null
  })
})

function request(): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'test.inspectCaller', params: {} }
}

describe('the in-process caller identity a transport vouches for', () => {
  it('reaches a unary handler from the transport that set it', async () => {
    const dispatcher = new RpcDispatcher({ runtime: RUNTIME, methods: [INSPECT] })

    const response = await dispatcher.dispatch(request(), {
      clientKind: 'runtime',
      trustedLocalCallerId: 'desktop-renderer'
    })

    expect(response).toMatchObject({
      ok: true,
      result: { trustedLocalCallerId: 'desktop-renderer' }
    })
  })

  it('is absent for a transport that set none, whatever the request carries', async () => {
    const dispatcher = new RpcDispatcher({ runtime: RUNTIME, methods: [INSPECT] })

    const response = await dispatcher.dispatch(
      { ...request(), params: { trustedLocalCallerId: 'desktop-renderer' } },
      { clientKind: 'runtime' }
    )

    expect(response).toMatchObject({ ok: true, result: { trustedLocalCallerId: null } })
  })
})
