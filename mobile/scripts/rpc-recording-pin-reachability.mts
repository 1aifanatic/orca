/**
 * Whether the RPC recording pin names a commit this repository keeps: one in this history, or one in
 * the head of the pull request whose squash wrote it into the manifest.
 */
import { runProcess } from '../../src/shared/child-process/run-process.ts'

export const PIN_MANIFEST = 'mobile/rpc-foundation/pilot-scenarios.json'
const PIN_REMOTE = 'origin'
// A blobless clone fetches the manifest's blobs one commit at a time, a few seconds each, so the
// 30 s process default kills the walk after a handful of commits that touched the manifest.
const PIN_LOOKUP_TIMEOUT_MS = 600_000
const PIN_FETCH_TIMEOUT_MS = 180_000

export type PinReachabilityFailure = 'shallow' | 'unreachable' | 'not-an-ancestor'
export type PinReachabilityVerdict =
  | { ok: true; baseline: string; ref: string; pullRequest: number | null }
  | { ok: false; baseline: string; ref: string; failure: PinReachabilityFailure; message: string }

async function git(cwd: string, args: readonly string[], timeoutMs?: number) {
  return await runProcess({ program: 'git', args: [...args], cwd, timeoutMs })
}
function failureDetail(result: { stderr: string; timedOut: boolean }, timeoutMs: number): string {
  return result.timedOut ? `timed out after ${timeoutMs / 1000}s` : result.stderr.trim()
}
export function repinInstruction(baseline: string, ref: string, cause: string): string {
  return [
    `The RPC recording corpus is pinned to a commit that ${cause}.`,
    '',
    `  baseline  ${baseline}   (mobile/rpc-foundation/pilot-scenarios.json)`,
    `  head      ${ref}`,
    '',
    'Every golden under mobile/rpc-foundation/goldens claims it was recorded from that tree, and',
    '`--record` refuses on any other tree, so the corpus cannot be refreshed until the pin names a',
    'commit that is reachable from here. Repin and re-record, both in one commit:',
    '',
    `  git switch -c repin-rpc-recording ${ref}`,
    `  # set "baseline" in mobile/rpc-foundation/pilot-scenarios.json to ${ref}`,
    '  ORCA_BACKGROUND_LAUNCH=1 RPC_FOUNDATION_RECORD=1 \\',
    '    pnpm --dir mobile exec tsx scripts/rpc-recording.mts --record',
    '',
    'Re-record everything: the repin rewrites the `baseline` header of every golden, so a partial',
    'refresh leaves the corpus pinned to two different trees. See',
    'mobile/src/test-support/rpc-recording/README.md, "Recording a behaviour change".'
  ].join('\n')
}
const SHALLOW_MESSAGE = [
  'Cannot judge the recording pin: this is a shallow clone.',
  '',
  '`git merge-base --is-ancestor` answers from grafted history, so it would report a verdict this',
  'guard has no evidence for. Check out with `fetch-depth: 0`.'
].join('\n')

async function isAncestor(root: string, commit: string, of: string): Promise<boolean> {
  const ancestor = await git(root, ['merge-base', '--is-ancestor', commit, of])
  // Why only 0 and 1: git reserves higher codes for real errors, and treating one as "not an
  // ancestor" would turn a broken repository into a repin instruction nobody can act on.
  if (ancestor.code !== 0 && ancestor.code !== 1) {
    throw new Error(`git merge-base --is-ancestor failed: ${ancestor.stderr.trim()}`)
  }
  return ancestor.code === 0
}

/**
 * The pull request whose squash wrote `baseline` into the manifest, from its `(#n)` subject.
 * First-parent, so a merge preview resolves through the base branch the squash will land on.
 */
async function landingPullRequest(root: string, baseline: string, ref: string) {
  const landed = await git(
    root,
    [
      'log',
      '--first-parent',
      '--max-count=1',
      '--format=%s',
      `-S${baseline}`,
      ref,
      '--',
      PIN_MANIFEST
    ],
    PIN_LOOKUP_TIMEOUT_MS
  )
  if (landed.code !== 0) {
    throw new Error(
      `Could not find the commit that pinned ${baseline}: ${failureDetail(landed, PIN_LOOKUP_TIMEOUT_MS)}`
    )
  }
  const number = /\(#(\d+)\)\s*$/.exec(landed.stdout.trim())?.[1]
  return number ? Number(number) : null
}

/** Fetches a pull request's head into a ref of our own, so no other fetch can move it under us. */
async function fetchPullRequestHead(root: string, pullRequest: number): Promise<string> {
  const local = `refs/rpc-recording-pin/pull/${pullRequest}`
  const fetched = await git(
    root,
    ['fetch', '--quiet', '--no-tags', PIN_REMOTE, `+refs/pull/${pullRequest}/head:${local}`],
    PIN_FETCH_TIMEOUT_MS
  )
  if (fetched.code !== 0) {
    throw new Error(
      `Could not fetch refs/pull/${pullRequest}/head from ${PIN_REMOTE}, the head of the pull ` +
        `request that pinned the recording corpus: ${failureDetail(fetched, PIN_FETCH_TIMEOUT_MS)}`
    )
  }
  return local
}

export async function checkPinReachable(
  root: string,
  baseline: string,
  ref: string
): Promise<PinReachabilityVerdict> {
  const shallow = await git(root, ['rev-parse', '--is-shallow-repository'])
  if (shallow.code !== 0) {
    throw new Error(`Could not ask git whether the clone is shallow: ${shallow.stderr.trim()}`)
  }
  if (shallow.stdout.trim() !== 'false') {
    return { ok: false, baseline, ref, failure: 'shallow', message: SHALLOW_MESSAGE }
  }
  const head = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (head.code !== 0) {
    throw new Error(`Cannot resolve ${ref} to a commit in this repository`)
  }
  // Resolved, because the instruction below is a command to paste: `HEAD` in it moves with whatever
  // the reader has checked out by the time they read the log.
  const resolved = head.stdout.trim()
  const present = async () =>
    (await git(root, ['rev-parse', '--verify', '--quiet', `${baseline}^{commit}`])).code === 0
  if ((await present()) && (await isAncestor(root, baseline, ref))) {
    return { ok: true, baseline, ref, pullRequest: null }
  }
  // A squash drops the branch commit the pin names, and the branch may already be deleted, but
  // GitHub keeps the pull request's head ref for good.
  const pullRequest = await landingPullRequest(root, baseline, ref)
  if (pullRequest !== null) {
    const pullRequestHead = await fetchPullRequestHead(root, pullRequest)
    if ((await present()) && (await isAncestor(root, baseline, pullRequestHead))) {
      return { ok: true, baseline, ref, pullRequest }
    }
  }
  if (!(await present())) {
    return {
      ok: false,
      baseline,
      ref,
      failure: 'unreachable',
      message: repinInstruction(baseline, resolved, 'is not a commit in this repository at all')
    }
  }
  return {
    ok: false,
    baseline,
    ref,
    failure: 'not-an-ancestor',
    message: repinInstruction(
      baseline,
      resolved,
      pullRequest === null
        ? 'is not an ancestor of this commit, and the commit that pinned it names no pull request'
        : `is neither an ancestor of this commit nor in refs/pull/${pullRequest}/head, the pull ` +
            'request that pinned it'
    )
  }
}
