import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { csvGridKeyDown } from './csv-grid-keyboard'
import type { CsvCellEditSession, CsvGridInteraction } from './csv-grid-interaction'
import {
  csvSelectionBounds,
  moveCsvSelection,
  remapCsvSelectionAfterColumnMove,
  type CsvCellSelection
} from './csv-cell-selection'
import { useCsvClipboard } from './useCsvClipboard'
import { csvSourceRow } from './csv-inspection'
import {
  mutateCsvTextDocument,
  type CsvTextDocument,
  type CsvTableMutation
} from './csv-text-document'
import { useCsvPendingCell } from './useCsvPendingCell'

export function useCsvTableEditor({
  document,
  inspectionRows,
  onContentChange,
  onSave,
  onStructureChange,
  fileId,
  isDirty,
  onDirtyStateHint
}: {
  document: CsvTextDocument | null
  fileId?: string
  isDirty?: boolean
  onDirtyStateHint?: (dirty: boolean) => void
  inspectionRows: number[] | null
  onContentChange?: (content: string) => void
  onSave?: (content: string) => Promise<boolean>
  onStructureChange: (mutation: CsvTableMutation) => void
}) {
  const ownerId = useId()
  const [selected, setSelected] = useState<CsvCellSelection | null>(null)
  const [editing, setEditing] = useState<CsvCellEditSession | null>(null)
  const editingRef = useRef<CsvCellEditSession | null>(null)
  const setCellEditing = (next: CsvCellEditSession | null): void => {
    editingRef.current = next
    setEditing(next)
  }
  const [focusVersion, setFocusVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const mounted = useRef(true)
  const current = useRef(document)
  useLayoutEffect(() => {
    current.current = document
  }, [document])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const count = inspectionRows?.length ?? Math.max(0, (document?.rows.length ?? 0) - 1)
  const columns = document?.columnCount ?? 0
  const clamp = (position: { row: number; column: number }) => ({
    row: Math.min(position.row, count),
    column: Math.min(position.column, Math.max(0, columns - 1))
  })
  const selection =
    selected && columns ? { anchor: clamp(selected.anchor), focus: clamp(selected.focus) } : null
  const fail = (reason: unknown): void => {
    if (mounted.current) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const apply = (mutation: CsvTableMutation): boolean => {
    if (!document || !onContentChange || current.current?.source !== document.source) {
      return false
    }
    try {
      const result = mutateCsvTextDocument(document, mutation)
      if (result !== document.source) {
        onContentChange(result)
        onStructureChange(mutation)
        if (mutation.kind === 'move-column') {
          setSelected((previous) =>
            remapCsvSelectionAfterColumnMove(previous, mutation.from, mutation.to)
          )
        } else if (mutation.kind !== 'cells') {
          setSelected(null)
        }
      }
      setError(null)
      return true
    } catch (reason) {
      fail(reason)
      return false
    }
  }
  const commit = (): boolean => {
    const draft = editingRef.current
    if (!draft) {
      return true
    }
    if (draft.source !== document?.source) {
      fail(new Error('CSV changed while this cell was being edited. Cancel and try again.'))
      return false
    }
    const applied = apply({
      kind: 'cells',
      edits: [{ row: draft.sourceRow, column: draft.position.column, value: draft.value }]
    })
    if (applied) {
      setCellEditing(null)
      if (draft.value === document.rows[draft.sourceRow]?.[draft.position.column]) {
        onDirtyStateHint?.(draft.wasDirty)
      }
    }
    return applied
  }
  const setRootRef = useCsvPendingCell({
    fileId,
    commit,
    document,
    onContentChange,
    editingRef,
    onSessionChange: setCellEditing
  })
  const select = (row: number, column: number, extend: boolean): boolean => {
    if (!commit()) {
      return false
    }
    setSelected((previous) => moveCsvSelection(previous, row, column, extend))
    setFocusVersion((previous) => previous + 1)
    return true
  }
  const edit = (row: number, column: number): void => {
    if (!document || !onContentChange || !commit()) {
      return
    }
    const sourceRow = csvSourceRow(row, inspectionRows)
    if (!document.rows[sourceRow]) {
      return
    }
    setSelected(moveCsvSelection(null, row, column, false))
    setCellEditing({
      position: { row, column },
      sourceRow,
      source: document.source,
      wasDirty: Boolean(isDirty),
      value: document.rows[sourceRow]?.[column] ?? ''
    })
  }
  const { pasteText, paste, copy, copyEvent, pasteEvent } = useCsvClipboard({
    document,
    selection,
    columns,
    inspectionRows,
    ownerId,
    fail,
    apply: (edits) => apply({ kind: 'cells', edits })
  })
  const save = async (): Promise<void> => {
    if (!document || !onSave || saving || !commit()) {
      return
    }
    setSaving(true)
    try {
      const source = editing
        ? mutateCsvTextDocument(document, {
            kind: 'cells',
            edits: [
              {
                row: editing.sourceRow,
                column: editing.position.column,
                value: editing.value
              }
            ]
          })
        : document.source
      if (!(await onSave(source))) {
        throw new Error('CSV could not be saved. Your edits remain in the draft.')
      }
    } catch (reason) {
      fail(reason)
    } finally {
      if (mounted.current) {
        setSaving(false)
      }
    }
  }
  const clear = (): void => pasteText('')
  const interaction: CsvGridInteraction | undefined = onContentChange
    ? {
        selection,
        editing,
        focusVersion,
        ownerId,
        select,
        edit,
        change: (value) => {
          const previous = editingRef.current
          if (!previous) {
            return
          }
          setCellEditing({ ...previous, value })
          onDirtyStateHint?.(
            previous.wasDirty ||
              value !== document?.rows[previous.sourceRow]?.[previous.position.column]
          )
        },
        commit,
        save: () => void save(),
        cancel: () => {
          const previous = editingRef.current
          setCellEditing(null)
          if (previous?.source === document?.source) {
            onDirtyStateHint?.(previous?.wasDirty ?? false)
          }
          setError(null)
        },
        keyDown: (event) =>
          csvGridKeyDown(event, {
            selection,
            columns,
            count,
            copy,
            paste,
            save,
            edit,
            clear,
            select,
            cancel: () => {
              setSelected(null)
              setCellEditing(null)
            },
            selectAll: setSelected
          }),
        copy: copyEvent,
        paste: pasteEvent
      }
    : undefined
  const selectedRows = (): number[] => {
    if (!selection) {
      return []
    }
    const bounds = csvSelectionBounds(selection)
    return Array.from({ length: bounds.lastRow - bounds.firstRow + 1 }, (_, index) =>
      csvSourceRow(bounds.firstRow + index, inspectionRows)
    )
  }
  return {
    interaction,
    selection,
    error,
    saving,
    apply,
    save,
    copy,
    paste,
    edit,
    selectedRows,
    setRootRef
  }
}
