import type { PaneLayoutEditIntent } from '../../../../shared/rpc-contract/session-tabs-schemas-params'

export type LayoutPersistOptions = { intent?: PaneLayoutEditIntent }

export const GESTURE_LAYOUT_PERSIST: LayoutPersistOptions = { intent: 'gesture' }
