// Files that identify one packaged build; paths are relative to the unpacked or installed app root.
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const IDENTITY_FILES = {
  executable: 'Orca.exe',
  appAsar: 'resources/app.asar',
  cliPackage: 'resources/app.asar.unpacked/out/package.json',
  cliLauncher: 'resources/bin/orca.exe',
  bunRuntime: 'resources/cli-runtime/bun-runtime.exe',
  bunManifest: 'resources/cli-runtime/runtime.json',
  daemonEntry: 'resources/terminal-daemon/daemon-entry.js'
}

export async function hashFile(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk)
  }
  return digest.digest('hex')
}

export async function hashIdentity(appRoot) {
  const hashes = {}
  for (const [field, relative] of Object.entries(IDENTITY_FILES)) {
    hashes[field] = await hashFile(join(appRoot, ...relative.split('/')))
  }
  return hashes
}

export function packagedVersion(appRoot) {
  return JSON.parse(readFileSync(join(appRoot, ...IDENTITY_FILES.cliPackage.split('/')), 'utf8'))
    .version
}

export function packagedBunManifest(appRoot) {
  return JSON.parse(readFileSync(join(appRoot, ...IDENTITY_FILES.bunManifest.split('/')), 'utf8'))
}
