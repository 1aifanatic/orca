import { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { attemptEditorFileSave } from './editor-file-save-attempt'

export function MissingEditorFileBanner({ file }: { file: OpenFile }): React.JSX.Element {
  const [isRestoring, setIsRestoring] = useState(false)
  const mutation = file.externalMutation

  const handleRestore = async (): Promise<void> => {
    if (mutation !== 'deleted' && mutation !== 'renamed') {
      return
    }
    setIsRestoring(true)
    const state = useAppStore.getState()
    state.setExternalMutation(file.id, null)
    const saved = await attemptEditorFileSave({ fileId: file.id })
    if (!saved && state.openFiles.some((candidate) => candidate.id === file.id)) {
      state.setExternalMutation(file.id, mutation)
    }
    setIsRestoring(false)
  }

  return (
    <div role="alert" className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <TriangleAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="min-w-0 font-medium text-foreground">
            {translate(
              'auto.components.editor.MissingEditorFileBanner.78159b1fa5',
              'This file was moved or deleted on disk. Your unsaved edits are preserved and will not be saved automatically.'
            )}
          </span>
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={isRestoring}
          onClick={handleRestore}
        >
          {isRestoring
            ? translate('auto.components.editor.MissingEditorFileBanner.47ab026ad5', 'Restoring…')
            : translate(
                'auto.components.editor.MissingEditorFileBanner.0c5e9c04dc',
                'Restore File'
              )}
        </Button>
      </div>
    </div>
  )
}
