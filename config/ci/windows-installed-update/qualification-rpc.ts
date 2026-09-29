// Local diagnostic client: authenticated daemon identity and folder registration only.
import { join } from 'node:path'
import { RuntimeClient } from '../../../src/cli/runtime/client'
import { DaemonClient } from '../../../src/main/daemon/client'
import { getDaemonSocketPath, getDaemonTokenPath } from '../../../src/main/daemon/daemon-spawner'

async function identity(profile: string): Promise<void> {
  const runtimeDir = join(profile, 'daemon')
  const client = new DaemonClient({
    socketPath: getDaemonSocketPath(runtimeDir),
    tokenPath: getDaemonTokenPath(runtimeDir)
  })
  try {
    // The probe must not keep the owner alive across transitions.
    await client.ensureConnectedWithin(2_000)
    const current = client.getDaemonIdentity()
    if (!current) {
      throw new Error('daemon_identity_unavailable')
    }
    const { pid, startedAtMs, launchNonce, entryPath, appVersion } = current
    console.log(
      JSON.stringify({ identity: { pid, startedAtMs, launchNonce, entryPath, appVersion } })
    )
  } finally {
    client.disconnect()
  }
}

async function registerFolder(profile: string, path: string): Promise<void> {
  const code = process.env.ORCA_PAIRING_CODE
  if (!path || !code) {
    throw new Error('folder_registration_requires_path_and_pairing')
  }
  const client = new RuntimeClient(profile, 30_000, code, null)
  const { result } = await client.call('repo.add', { path, kind: 'folder' })
  console.log(JSON.stringify(result))
}

async function main(): Promise<void> {
  const [mode, profile, path] = process.argv.slice(2)
  if (!profile) {
    throw new Error('explicit_disposable_profile_required')
  }
  if (mode === 'identity') {
    await identity(profile)
  } else if (mode === 'folder') {
    await registerFolder(profile, path ?? '')
  } else {
    throw new Error('unknown_mode')
  }
}

void main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^[a-z_]{1,64}$/u.test(error.message) ? error.message : 'rpc_failed'
  console.error(JSON.stringify({ ok: false, error: { code } }))
  process.exitCode = 1
})
