import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { UISlice } from './ui/ui-slice-contract'
import { createUiAgentActions } from './ui/ui-slice-agent-actions'
import { createUiTaskActions } from './ui/ui-slice-task-actions'
import { createUiViewActions } from './ui/ui-slice-view-actions'
import { createUiSettingsActions } from './ui/ui-slice-settings-actions'
import { createUiModalActions } from './ui/ui-slice-modal-actions'
import { createUiFeatureActions } from './ui/ui-slice-feature-actions'
import { createUiTourActions } from './ui/ui-slice-tour-actions'
import { createUiPromptTurnActions } from './ui/ui-slice-prompt-turn-actions'
import { createUiTrustActions } from './ui/ui-slice-trust-actions'
import { createUiPreferenceActions } from './ui/ui-slice-preference-actions'
import { createUiSurfaceActions } from './ui/ui-slice-surface-actions'
import { createUiPersistenceActions } from './ui/ui-slice-persistence-actions'
import { createUiHydrationActions } from './ui/ui-slice-hydration-actions'
import { createUiUpdateActions } from './ui/ui-slice-update-actions'

export type {
  AgentSendPopoverTargetMode,
  NewWorkspaceDraft,
  OpenAgentSendPopoverTargetModeArgs,
  PendingSidebarRowReveal,
  PendingSidebarWorktreeReveal,
  TaskPageData,
  UISlice
} from './ui/ui-slice-contract'

export const createUISlice: StateCreator<AppState, [], [], UISlice> = (set, get) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each group returns its part of UISlice and together they supply every key; the UI slice tests build the whole slice.
  ({
    ...createUiAgentActions(set, get),
    ...createUiTaskActions(set, get),
    ...createUiViewActions(set, get),
    ...createUiSettingsActions(set, get),
    ...createUiModalActions(set, get),
    ...createUiFeatureActions(set, get),
    ...createUiTourActions(set, get),
    ...createUiPromptTurnActions(set, get),
    ...createUiTrustActions(set, get),
    ...createUiPreferenceActions(set, get),
    ...createUiSurfaceActions(set, get),
    ...createUiPersistenceActions(set, get),
    ...createUiHydrationActions(set, get),
    ...createUiUpdateActions(set, get)
  }) as UISlice
