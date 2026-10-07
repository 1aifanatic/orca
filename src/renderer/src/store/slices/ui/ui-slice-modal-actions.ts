import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { settleEvictedModalData } from '../modal-slot-dismissal'
import { useDialogRegistry } from '../../dialog-registry'

export function createUiModalActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  return {
    activeModal: 'none',
    modalData: {},
    openModal: (modal, data = {}) => {
      if (modal === 'add-repo' || modal === 'create-worktree') {
        get().recordFeatureInteraction?.('workspace-creation')
      }
      const evicted = get().modalData
      // Before the slot changes, so its dialog counts from here even while its code loads.
      useDialogRegistry.getState().openModalSlot(modal)
      set({
        activeModal: modal,
        modalData: data
      })
      settleEvictedModalData(evicted)
    },
    closeModal: () => {
      const evicted = get().modalData
      useDialogRegistry.getState().closeModalSlot()
      set({ activeModal: 'none', modalData: {} })
      settleEvictedModalData(evicted)
    }
  }
}
