import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import { canForgetFailedLocalDelete } from './ForgetFailedDeleteMenuItem'

vi.mock('@/store', () => ({ useAppStore: vi.fn() }))

const failedRow = {
  id: 'repo-1::/workspace/feature-wt',
  displayName: 'feature-wt',
  removalError: "error: failed to delete '/workspace/feature-wt': Operation not permitted"
}
const localRepo = { connectionId: null }

describe('canForgetFailedLocalDelete', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('offers Remove from Orca on a local row whose delete failed', () => {
    expect(canForgetFailedLocalDelete(failedRow, localRepo)).toBe(true)
    expect(
      canForgetFailedLocalDelete({ ...failedRow, hostId: LOCAL_EXECUTION_HOST_ID }, localRepo)
    ).toBe(true)
  })

  it('is not offered on a row without a failed delete', () => {
    expect(canForgetFailedLocalDelete({ ...failedRow, removalError: undefined }, localRepo)).toBe(
      false
    )
  })

  it('is not offered on rows another process owns', () => {
    expect(
      canForgetFailedLocalDelete({ ...failedRow, hostId: toSshExecutionHostId('box') }, localRepo)
    ).toBe(false)
    expect(canForgetFailedLocalDelete(failedRow, { connectionId: 'box' })).toBe(false)
    expect(
      canForgetFailedLocalDelete(
        {
          ...failedRow,
          hostId: toRuntimeExecutionHostId('env-1'),
          runtimeOwnerEnvironmentId: 'env-1'
        },
        localRepo
      )
    ).toBe(false)
    expect(
      canForgetFailedLocalDelete({ ...failedRow, runtimeOwnerEnvironmentId: 'env-1' }, localRepo)
    ).toBe(false)
  })

  it('is not offered in a paired web client, which cannot forget', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    expect(canForgetFailedLocalDelete(failedRow, localRepo)).toBe(false)
  })
})
