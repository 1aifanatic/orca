import { beforeAll, expect, it } from 'bun:test'
let elapsed = 0
beforeAll(async () => {
  const started = performance.now()
  await new Promise(resolve => setTimeout(resolve, 31_000))
  elapsed = performance.now() - started
}, 60_000)
it('honors the explicit sixty-second hook budget above the test default', () => {
  expect(elapsed).toBeGreaterThanOrEqual(30_000)
  console.log('ORCA_NATIVE_SENTINEL ' + JSON.stringify({ kind: 'hook-budget', elapsed, pid: process.pid }))
})
