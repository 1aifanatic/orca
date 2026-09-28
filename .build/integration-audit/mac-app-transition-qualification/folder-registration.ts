import { RuntimeClient } from '../../../src/cli/runtime/client'

async function main(): Promise<void> {
  const [profile, path] = process.argv.slice(2)
  const code = process.env.ORCA_PAIRING_CODE
  if (!profile || !path || !code) throw new Error('Explicit disposable profile/path/pairing required')
  const client = new RuntimeClient(profile, 30_000, code, null)
  const result = await client.call('repo.add', { path, kind: 'folder' })
  console.log(JSON.stringify(result.result))
}
void main().catch(() => {
  console.error('Folder registration failed')
  process.exitCode = 1
})
