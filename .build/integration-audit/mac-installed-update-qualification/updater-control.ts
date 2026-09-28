// Local diagnostic client; deliberately cannot change feeds or initiate public-release checks.
import { RuntimeClient } from '../../../src/cli/runtime/client'
import type { RemoteServerUpdaterSnapshot, RemoteServerUpdateInstallResult } from '../../../src/shared/remote-server-update'

async function main(): Promise<void> {
  const [profile, action] = process.argv.slice(2)
  const pairing = process.env.ORCA_PAIRING_CODE
  if (!profile || !pairing || !['status', 'download', 'install'].includes(action)) {
    throw new Error('Explicit disposable profile, pairing and status/download/install action required')
  }
  const client = new RuntimeClient(profile, 30_000, pairing, null)
  if (action === 'install') {
    const { result } = await client.call<RemoteServerUpdateInstallResult>('updater.install', {})
    console.log(JSON.stringify({ accepted: result.accepted, fromVersion: result.fromVersion, targetVersion: result.targetVersion, runtimeId: result.runtimeId }))
    return
  }
  const { result } = await client.call<RemoteServerUpdaterSnapshot>(action === 'status' ? 'updater.getStatus' : 'updater.download', {})
  console.log(JSON.stringify({
    appVersion: result.appVersion,
    runtimeId: result.runtimeId,
    support: { installMode: result.support.installMode, automatic: result.support.automatic, reason: result.support.reason },
    status: { state: result.status.state, ...('version' in result.status ? { version: result.status.version } : {}) }
  }))
}
void main().catch((error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'diagnostic_updater_rpc_failed'
  console.error(JSON.stringify({ ok: false, error: { code } }))
  process.exitCode = 1
})
