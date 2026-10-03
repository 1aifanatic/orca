import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const key = process.env.CACHE_KEY
if (
  process.env.GITHUB_ACTIONS !== 'true' ||
  process.platform !== 'linux' ||
  root !== process.env.GITHUB_WORKSPACE ||
  !key?.startsWith('ci-lookup-access-trial-')
) {
  throw new Error('Disposable hosted lookup trial required')
}
const directory = join(process.env.RUNNER_TEMP, 'cache-lookup-access')
mkdirSync(directory, { recursive: true })
const marker = join(process.env.RUNNER_TEMP, 'cache-lookup-marker')
const beforePath = join(directory, 'before.json')

async function record() {
  const url = new URL(
    `/repos/${process.env.GITHUB_REPOSITORY}/actions/caches`,
    process.env.GITHUB_API_URL
  )
  url.search = new URLSearchParams({ key, ref: process.env.GITHUB_REF }).toString()
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json'
    }
  })
  if (!response.ok) {
    throw new Error(`Cache metadata request failed: ${response.status}`)
  }
  const body = await response.json()
  const rows = body.actions_caches.filter((row) => row.key === key)
  if (rows.length !== 1 || rows[0].ref !== process.env.GITHUB_REF) {
    throw new Error('Expected one branch-scoped cache record')
  }
  return rows[0]
}

if (process.argv[2] === 'before') {
  if (existsSync(marker)) {
    throw new Error('Fresh runner must not contain the marker')
  }
  const before = await record()
  writeFileSync(beforePath, JSON.stringify(before))
  console.log(JSON.stringify({ phase: 'before', id: before.id, accessed: before.last_accessed_at }))
} else if (process.argv[2] === 'after') {
  if (process.env.LOOKUP_HIT !== 'true' || existsSync(marker)) {
    throw new Error('Lookup must find the exact cache without restoring its marker')
  }
  const before = JSON.parse(readFileSync(beforePath, 'utf8'))
  for (let attempt = 0; attempt < 7; attempt++) {
    const after = await record()
    if (
      after.id !== before.id ||
      after.version !== before.version ||
      after.size_in_bytes !== before.size_in_bytes
    ) {
      throw new Error('Lookup unexpectedly replaced the cache')
    }
    if (Date.parse(after.last_accessed_at) > Date.parse(before.last_accessed_at)) {
      writeFileSync(join(directory, 'after.json'), JSON.stringify(after))
      console.log(JSON.stringify({ refreshed: true, downloaded: false, id: after.id }))
      process.exit(0)
    }
    if (attempt < 6) {
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
  }
  throw new Error('Lookup did not refresh the observable access timestamp')
} else {
  throw new Error('Expected before or after')
}
