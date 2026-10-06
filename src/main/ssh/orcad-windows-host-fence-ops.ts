/**
 * The activation fence's ownership check and conditional release inside the Windows host script,
 * matching the POSIX guard in `orcad-activation-fence-scope.ts`.
 */
import {
  ORCAD_FENCE_LOST_EXIT,
  ORCAD_FENCE_LOST_MARKER,
  ORCAD_FENCE_OWNER_FILENAME
} from './orcad-activation-fence-scope'

export const ORCAD_WINDOWS_FENCE_ARG = '--fence'

const text = JSON.stringify

/** Strips `--fence <lockDir> <token>` and exits before the op unless the token is still ours. */
export const ORCAD_WINDOWS_FENCE_PRELUDE = `
function fenceOwner(lockDir) {
  try { return fs.readFileSync(path.join(lockDir, ${text(ORCAD_FENCE_OWNER_FILENAME)}), 'utf8') } catch { return null }
}
// The token this op runs under; null outside a fence, so nothing refreshes a fence it does not own.
let FENCE_TOKEN = null
let FENCE_DIR = null
function fencedArgv(argv) {
  if (argv[0] !== ${text(ORCAD_WINDOWS_FENCE_ARG)}) return argv
  FENCE_DIR = argv[1]
  FENCE_TOKEN = argv[2]
  if (fenceOwner(argv[1]) !== argv[2]) {
    process.stdout.write(${text(`${ORCAD_FENCE_LOST_MARKER}\n`)}, () => process.exit(${ORCAD_FENCE_LOST_EXIT}))
    return ['fence-lost']
  }
  return argv.slice(3)
}
`

export const ORCAD_WINDOWS_HOST_FENCE_OPS = `
Object.assign(ops, {
  'fence-lost'() {},
  'fence-check'() {
    answer('OK')
  },
  // Journal first, then the lock aside, so a successor's fresh lock is never what gets removed.
  'fence-release'(lockDir, journal, token) {
    if (fenceOwner(lockDir) !== token) return answer('SUPERSEDED')
    try { fs.unlinkSync(journal) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const aside = lockDir + '.released.' + process.pid
    fs.renameSync(lockDir, aside)
    fs.rmSync(aside, { recursive: true, force: true, maxRetries: 5 })
    try { fs.rmdirSync(path.dirname(lockDir)) } catch {}
    answer('RELEASED')
  }
})
`
