import { beforeEach, it } from 'bun:test'
beforeEach(() => { throw new Error('ORCA_NATIVE_HOOK_FAILURE_SENTINEL') }, 60_000)
it('rejects an actual hook error before entering the case', () => {
  console.log('ORCA_NATIVE_HOOK_BODY_UNEXPECTED')
})
