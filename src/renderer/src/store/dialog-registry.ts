import { create } from 'zustand'
import {
  closeDialogEntry,
  closeModalSlotEntry,
  dialogContentMounted,
  dialogContentUnmounted,
  endDialogEntry,
  enqueueAutomaticDialog,
  INITIAL_DIALOG_REGISTRY,
  openDialogEntry,
  openModalSlotEntry,
  settleStartupSource,
  syncTourEntry,
  type DialogRegistry
} from './dialog-registry-state'

type DialogRegistryActions = {
  openDialog: (...args: DropFirst<Parameters<typeof openDialogEntry>>) => void
  enqueueAutomaticDialog: (...args: DropFirst<Parameters<typeof enqueueAutomaticDialog>>) => void
  closeDialog: (token: string) => void
  endDialog: (token: string) => void
  dialogContentMounted: (token: string) => void
  dialogContentUnmounted: (token: string) => void
  settleStartupSource: (...args: DropFirst<Parameters<typeof settleStartupSource>>) => void
  openModalSlot: (modal: string) => void
  closeModalSlot: () => void
  syncTour: (tourId: string | null) => void
}

type DropFirst<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never

export type DialogRegistryStore = DialogRegistry & DialogRegistryActions

// Why a standalone store instead of an AppState slice: the shared Dialog primitive registers into
// it, and many renderer tests render real dialogs under a factory-mocked '@/store' that has no
// registry. One store per window either way, so every answer still reads one list.
export const useDialogRegistry = create<DialogRegistryStore>()((set) => ({
  ...INITIAL_DIALOG_REGISTRY,
  openDialog: (...args) => set((s) => openDialogEntry(s, ...args)),
  enqueueAutomaticDialog: (...args) => set((s) => enqueueAutomaticDialog(s, ...args)),
  closeDialog: (token) => set((s) => closeDialogEntry(s, token)),
  endDialog: (token) => set((s) => endDialogEntry(s, token)),
  dialogContentMounted: (token) => set((s) => dialogContentMounted(s, token)),
  dialogContentUnmounted: (token) => set((s) => dialogContentUnmounted(s, token)),
  settleStartupSource: (...args) => set((s) => settleStartupSource(s, ...args)),
  openModalSlot: (modal) => set((s) => openModalSlotEntry(s, modal)),
  closeModalSlot: () => set((s) => closeModalSlotEntry(s)),
  syncTour: (tourId) => set((s) => syncTourEntry(s, tourId))
}))

/** @internal - tests start from an empty registry; `startupSettled` models a running app. */
export function resetDialogRegistryForTests(options: { startupSettled?: boolean } = {}): void {
  useDialogRegistry.setState({
    ...INITIAL_DIALOG_REGISTRY,
    ...(options.startupSettled
      ? {
          startupSources: {
            'crash-report': 'none',
            'feature-tip': 'none',
            'native-chat-resume': 'none'
          }
        }
      : {})
  })
}
