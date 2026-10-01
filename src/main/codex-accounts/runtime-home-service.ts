import type { Store } from '../persistence'
import { CodexRuntimeHomeMirrorRetirement } from './runtime-home-service-mirror-retirement'

export type {
  CodexMirroredHomeStatus,
  CodexRateLimitHomeResolution
} from './runtime-home-service-types'

export class CodexRuntimeHomeService extends CodexRuntimeHomeMirrorRetirement {
  constructor(store: Store) {
    super(store)
    this.safeRecoverInterruptedRuntimeAuthOperation()
    this.safeMigrateLegacySharedAuth()
    this.safeMigrateLegacyManagedState()
    this.safeMigrateLegacyActiveHomePointer()
    this.initializeLastSyncedState()
    this.safeSyncForCurrentSelection()
  }
}
