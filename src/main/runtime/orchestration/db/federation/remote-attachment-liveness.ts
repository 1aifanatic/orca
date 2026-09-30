import type { WorkerDispatchState } from '../../types'

export const POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES = [
  'starting',
  'ready',
  'start_unknown',
  'stopping',
  'stop_unknown'
] as const satisfies readonly WorkerDispatchState[]

// Why: an unknown start or stop is unverifiable, not exited, so the worker's own report settles it.
export const SETTLEABLE_REMOTE_ATTACHMENT_STATES: readonly WorkerDispatchState[] = [
  'ready',
  'start_unknown',
  'stop_unknown'
]

export function potentiallyLiveRemoteAttachmentSql(column = 'state'): string {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(column)) {
    throw new Error(`Invalid remote attachment state column: ${column}`)
  }
  return `${column} IN (${POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES.map((state) => `'${state}'`).join(', ')})`
}
