import { randomUUID } from 'node:crypto'

export const nativeFileRealmObservation = { ownerNonce: randomUUID(), fileCount: 0 }
