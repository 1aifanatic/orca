import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

export function captureArtifactInventory(directory, root) {
  const entries = []
  function walk(path, relative) {
    if (
      directory === join(root, 'node_modules') &&
      ['./.vite', './.vite-temp'].includes(relative)
    ) {
      return
    }
    const stat = lstatSync(path)
    const entry = { path: relative, mode: stat.mode & 0o777 }
    if (stat.isSymbolicLink()) {
      entries.push({ ...entry, type: 'symlink', target: readlinkSync(path) })
    } else if (stat.isDirectory()) {
      entries.push({ ...entry, type: 'directory' })
      for (const name of readdirSync(path).sort()) {
        walk(join(path, name), `${relative}/${name}`)
      }
    } else if (stat.isFile()) {
      entries.push({
        ...entry,
        type: 'file',
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex')
      })
    } else {
      throw new Error(`Unsupported inventory entry: ${path}`)
    }
  }
  walk(directory, '.')
  return {
    sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    count: entries.length,
    entries
  }
}
