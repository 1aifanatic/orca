// Handing freed pages back to the filesystem under `auto_vacuum = INCREMENTAL`.
//
// That mode holds every freed page on the freelist until something asks for it back; nothing asks
// on its own, so a database that deletes and never reclaims only grows. Asking for a whole purge's
// worth at once is one long stall (40 ms per 22 MB freed, measured), so each call is capped.

import type SyncDatabase from './sync-database'

export const RECLAIM_PAGES_PER_STEP = 2000

export function freePageCount(db: SyncDatabase): number {
  return Number(db.pragma('freelist_count', { simple: true }) ?? 0)
}

/** One bounded step, run to completion. Returns the pages still on the freelist. */
export function reclaimFreePagesStep(
  db: SyncDatabase,
  maxPages: number = RECLAIM_PAGES_PER_STEP
): number {
  db.pragma(`incremental_vacuum(${maxPages})`)
  return freePageCount(db)
}
