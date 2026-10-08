import { describe, expect, it } from 'vitest'
import { MOBILE_RPC_METHOD_ALLOWLIST } from './runtime-rpc-mobile-method-allowlist'
import {
  MOBILE_RPC_METHOD_ROUTE_ENTRY_COUNT,
  MOBILE_RPC_METHOD_ROUTES
} from './runtime-rpc-mobile-method-routing'

describe('mobile RPC method routing census', () => {
  it('tags every allowlisted method exactly once', () => {
    const untagged = [...MOBILE_RPC_METHOD_ALLOWLIST].filter(
      (method) => !MOBILE_RPC_METHOD_ROUTES.has(method)
    )
    expect(untagged).toEqual([])
    expect(MOBILE_RPC_METHOD_ROUTE_ENTRY_COUNT).toBe(MOBILE_RPC_METHOD_ROUTES.size)
  })

  it('tags nothing outside the allowlist', () => {
    const stale = [...MOBILE_RPC_METHOD_ROUTES.keys()].filter(
      (method) => !MOBILE_RPC_METHOD_ALLOWLIST.has(method)
    )
    expect(stale).toEqual([])
  })
})
