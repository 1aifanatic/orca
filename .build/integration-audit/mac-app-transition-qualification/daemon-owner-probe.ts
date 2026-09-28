// Local-only identity observation; connection must not keep the owner alive across transitions.
import { join } from 'node:path'
import { DaemonClient } from '../../../src/main/daemon/client'
import { getDaemonSocketPath, getDaemonTokenPath } from '../../../src/main/daemon/daemon-spawner'

async function main(): Promise<void> {
  const profile = process.argv[2]
  if (!profile) throw new Error('An explicit disposable profile directory is required')
  const runtimeDir = join(profile, 'daemon')
  const client = new DaemonClient({
    socketPath: getDaemonSocketPath(runtimeDir),
    tokenPath: getDaemonTokenPath(runtimeDir)
  })
  try {
    await client.ensureConnectedWithin(2_000)
    const identity = client.getDaemonIdentity()
    if (!identity) throw new Error('Daemon identity unavailable')
    console.log(JSON.stringify({ identity }))
  } finally {
    client.disconnect()
  }
}
void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
