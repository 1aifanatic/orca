import { it } from 'bun:test'
it('rejects an actual unhandled promise error', () => {
  console.log('ORCA_NATIVE_UNHANDLED_BODY_ENTERED')
  void Promise.reject(new Error('ORCA_NATIVE_UNHANDLED_FAILURE_SENTINEL'))
})
