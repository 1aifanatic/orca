import { createContext } from 'react'

/** Whether this editor panel takes app-level chords such as find: its tab is the active tab of
 *  the focused group in the active workspace. A viewer outside a panel takes none. */
export const EditorShortcutOwnerContext = createContext(false)
