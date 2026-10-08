import { it } from 'bun:test'
it('enforces the unchanged thirty-second default without a local override', async () => {
  console.log('ORCA_NATIVE_TIMEOUT_BODY_ENTERED')
  await new Promise(() => {})
})
