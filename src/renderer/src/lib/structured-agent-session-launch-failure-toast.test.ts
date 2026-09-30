import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/agent-catalog', () => ({ getAgentCatalog: () => [] }))

import {
  StructuredAgentSessionHostDeclinedError,
  StructuredAgentSessionHostUnreachableError
} from '@/lib/launch-structured-agent-session'
import { trackStructuredLaunchFailureToast } from './structured-agent-session-launch-failure-toast'

async function failWith(error: unknown): Promise<void> {
  trackStructuredLaunchFailureToast('claude', Promise.reject(error))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('the structured launch failure toast', () => {
  it('stays quiet for a paired server whose terminal opens in its place', async () => {
    await failWith(new StructuredAgentSessionHostDeclinedError('runtime:server-1'))
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it.each([
    ['this machine declining', new StructuredAgentSessionHostDeclinedError('local')],
    ['an unreachable host', new StructuredAgentSessionHostUnreachableError('offline', 'x')]
  ])('reports %s', async (_name, error) => {
    await failWith(error)
    expect(mocks.toastError).toHaveBeenCalledOnce()
  })
})
